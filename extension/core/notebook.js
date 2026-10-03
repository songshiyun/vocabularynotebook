import { LIMITS, MAX_DEFINITION, mergeRecord, normalizeDefinition, normalizeWord, planSync, readBuckets, sameRecord, validRecord } from "./model.js";

export class Notebook {
  constructor({ local, sync, now = Date.now, actor = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16), limits = LIMITS }) {
    this.local = local;
    this.syncStorage = sync;
    this.now = now;
    this.actor = actor;
    this.limits = limits;
    this.queue = Promise.resolve();
    this.remote = {};
  }

  dispatch(command) {
    const task = this.queue.then(async () => {
      await this.initialize();
      await this.synchronize(command.changes);
      let result;
      if (command.type === "add") result = await this.add(command.word);
      else if (command.type === "edit") await this.edit(command.word, command.definition, command.expected);
      else if (command.type === "delete") await this.remove(command.word, command.expected);
      else if (!["list", "sync", "export"].includes(command.type)) throw new Error("不支持的操作。");
      if (["add", "edit", "delete"].includes(command.type)) await this.synchronize();
      return { ...this.snapshot(), ...result };
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async initialize() {
    if (this.state) return;
    const { notebook } = await this.local.get("notebook");
    if (notebook && notebook.version !== 1) throw new Error("本地数据版本不受支持，请保留数据并更新插件。");
    const state = notebook ?? { version: 1, actor: this.actor(), clock: 0, records: {}, issue: null };
    if (!state.records || typeof state.records !== "object" || Array.isArray(state.records) ||
      !Number.isSafeInteger(state.clock) || state.clock < 0 || typeof state.actor !== "string" || !/^[a-z0-9-]{1,64}$/.test(state.actor)) {
      throw new Error("本地数据损坏，已停止写入以保护原始数据。");
    }
    for (const [word, record] of Object.entries(state.records)) {
      if (normalizeWord(word) !== word || !validRecord(record)) throw new Error("本地数据损坏，已停止写入以保护原始数据。");
    }
    this.state = { ...state, records: Object.assign(Object.create(null), state.records) };
    this.saved = notebook ? JSON.stringify(notebook) : "";
    await this.persist();
  }

  tick() {
    this.state.clock = Math.max(this.now(), this.state.clock + 1);
    return this.state.clock;
  }

  async persist() {
    const serialized = JSON.stringify(this.state);
    if (serialized === this.saved) return;
    try {
      await this.local.set({ notebook: JSON.parse(serialized) });
      this.saved = serialized;
    } catch (error) {
      this.state = undefined;
      throw new Error(`本地保存失败，操作未完成：${error.message}`);
    }
  }

  ingest(values) {
    for (const [word, record] of Object.entries(readBuckets(values))) {
      this.state.records[word] = mergeRecord(this.state.records[word], record);
      this.state.clock = Math.max(this.state.clock, record[2]);
    }
  }

  async synchronize(changes) {
    if (changes) {
      this.ingest(Object.fromEntries(Object.entries(changes).filter(([, change]) => change.oldValue !== undefined).map(([key, change]) => [key, change.oldValue])));
      this.ingest(Object.fromEntries(Object.entries(changes).filter(([, change]) => change.newValue !== undefined).map(([key, change]) => [key, change.newValue])));
    }
    let remoteValues;
    try {
      remoteValues = await this.syncStorage.get(null);
    } catch (error) {
      this.state.issue = `Chrome 同步暂不可用：${error.message}`;
      this.remote = {};
      await this.persist();
      return;
    }
    this.remote = remoteValues;
    this.ingest(remoteValues);
    await this.persist();
    const plan = planSync(this.state.records, remoteValues, this.limits);
    if (Object.keys(plan.writes).length) {
      try {
        await this.syncStorage.set(plan.writes);
        this.remote = plan.values;
        this.state.issue = null;
      } catch (error) {
        this.state.issue = `尚未提交 Chrome：${error.message}`;
        await this.persist();
        return;
      }
    } else this.state.issue = null;
    if (this.pendingWords().length) this.state.issue = "同步空间不足，部分修改仅保存在当前电脑。请导出备份或精简手动释义。";
    await this.persist();
  }

  async add(input) {
    const word = normalizeWord(input);
    const existing = this.state.records[word];
    if (existing && !existing[5]) return { added: false, word };
    const timestamp = this.tick();
    const generation = existing ? `${timestamp}.${this.state.actor}` : "";
    this.state.records[word] = [generation, timestamp, timestamp, this.state.actor, null, 0];
    await this.persist();
    return { added: true, word };
  }

  editable(word, expected) {
    const record = this.state.records[word];
    if (!record || record[5]) throw new Error("这个单词已被删除，请刷新列表。");
    if (expected && !sameRecord(record, expected)) throw new Error("该单词已在其他窗口或设备更新，请刷新后重新编辑。");
    return record;
  }

  async edit(input, definition, expected) {
    const word = normalizeWord(input);
    const record = this.editable(word, expected);
    const customDefinition = normalizeDefinition(definition);
    if (record[4] === customDefinition) return;
    this.state.records[word] = [record[0], record[1], this.tick(), this.state.actor, customDefinition, 0];
    await this.persist();
  }

  async remove(input, expected) {
    const word = normalizeWord(input);
    const record = this.state.records[word];
    if (!record || record[5]) return;
    this.editable(word, expected);
    this.state.records[word] = [record[0], record[1], this.tick(), this.state.actor, null, 1];
    await this.persist();
  }

  pendingWords() {
    const remoteRecords = readBuckets(this.remote);
    return Object.entries(this.state.records).filter(([word, record]) => !sameRecord(record, remoteRecords[word])).map(([word]) => word);
  }

  snapshot() {
    const pending = new Set(this.pendingWords());
    const entries = Object.entries(this.state.records).filter(([, record]) => !record[5])
      .sort(([leftWord, left], [rightWord, right]) => right[1] - left[1] || leftWord.localeCompare(rightWord))
      .map(([word, record]) => ({ word, createdAt: record[1], customDefinition: record[4], pending: pending.has(word), revision: record.slice() }));
    return {
      entries,
      pending: pending.size,
      pendingDeletions: [...pending].filter(word => this.state.records[word][5]).length,
      issue: this.state.issue,
      bytes: planSync({}, this.remote, this.limits).totalBytes,
      quota: this.limits.total,
      maxDefinition: MAX_DEFINITION,
    };
  }
}
