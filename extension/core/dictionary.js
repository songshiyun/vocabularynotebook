import { normalizeWord } from "./model.js";

export class Dictionary {
  constructor({ load = async name => {
    const response = await fetch(new URL(`../dictionary/${name}.json`, import.meta.url));
    if (!response.ok) throw new Error("离线词典文件缺失，请重新安装完整插件。");
    return response.json();
  } } = {}) {
    this.load = load;
    this.cache = new Map();
    this.pending = new Map();
  }

  async lookup(input) {
    const word = normalizeWord(input);
    const shard = word.slice(0, 2).padEnd(2, "_");
    if (!this.cache.has(shard) && !this.pending.has(shard)) {
      const loading = this.load(shard).then(data => {
        if (this.cache.size >= 12) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(shard, data);
        this.pending.delete(shard);
        return data;
      }).catch(error => { this.pending.delete(shard); throw error; });
      this.pending.set(shard, loading);
    }
    const dictionary = this.cache.get(shard) ?? await this.pending.get(shard);
    return Object.hasOwn(dictionary, word) ? dictionary[word] : null;
  }
}
