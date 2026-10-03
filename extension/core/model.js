export const PREFIX = "wk1:";
export const MAX_DEFINITION = 1000;
export const LIMITS = { total: 102400, item: 8192, items: 512 };

export function normalizeWord(input) {
  if (typeof input !== "string") throw new Error("请选中一个英文单词。");
  const word = input.trim().replace(/[’‘]/g, "'").toLowerCase();
  if (word.length > 64 || !/^[a-z]+(?:['-][a-z]+)*$/.test(word)) {
    throw new Error("请选择一个英文单词，暂不支持短语、句子或数字。");
  }
  return word;
}

export function normalizeDefinition(input) {
  if (typeof input !== "string") throw new Error("释义必须是文本。");
  const definition = input.trim();
  if (definition.length > MAX_DEFINITION) throw new Error(`释义最多 ${MAX_DEFINITION} 个字符。`);
  return definition || null;
}

export function bucketFor(word) {
  let hash = 2166136261;
  for (const character of word) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${PREFIX}${(hash >>> 0 & 127).toString(16).padStart(2, "0")}`;
}

export function validRecord(record) {
  return Array.isArray(record) && record.length === 6 &&
    typeof record[0] === "string" && /^(?:|[0-9]+\.[a-z0-9-]{1,64})$/.test(record[0]) &&
    Number.isSafeInteger(record[1]) && record[1] > 0 &&
    Number.isSafeInteger(record[2]) && record[2] >= record[1] &&
    typeof record[3] === "string" && /^[a-z0-9-]{1,64}$/.test(record[3]) &&
    (record[4] === null || typeof record[4] === "string" && record[4].length <= MAX_DEFINITION) &&
    (record[5] === 0 || record[5] === 1);
}

function compareGeneration(left, right) {
  const [leftTime = "0", leftActor = ""] = left.split(".");
  const [rightTime = "0", rightActor = ""] = right.split(".");
  return Number(leftTime) - Number(rightTime) || compareText(leftActor, rightActor);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mergeRecord(left, right) {
  if (!left) return right.slice();
  if (!right) return left.slice();
  const generationOrder = compareGeneration(left[0], right[0]);
  if (generationOrder) return (generationOrder > 0 ? left : right).slice();
  const order = left[5] - right[5] || left[2] - right[2] ||
    compareText(left[3], right[3]) || compareText(left[4] ?? "", right[4] ?? "");
  const result = (order >= 0 ? left : right).slice();
  result[1] = Math.min(left[1], right[1]);
  if (result[5]) result[4] = null;
  return result;
}

export function sameRecord(left, right) {
  return !!left && !!right && left.length === right.length && left.every((value, index) => value === right[index]);
}

export function readBuckets(values) {
  const records = Object.create(null);
  for (const [key, bucket] of Object.entries(values)) {
    if (!key.startsWith(PREFIX) || !bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    for (const [word, record] of Object.entries(bucket)) {
      try {
        if (normalizeWord(word) === word && bucketFor(word) === key && validRecord(record)) records[word] = record;
      } catch {}
    }
  }
  return records;
}

const encoder = new TextEncoder();

export function bytesFor(key, value) {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}

export function planSync(records, remoteValues, limits = LIMITS) {
  const values = { ...remoteValues };
  let totalBytes = Object.entries(values).reduce((total, [key, value]) => total + bytesFor(key, value), 0);
  let itemCount = Object.keys(values).length;
  const writes = Object.create(null);
  const remoteRecords = readBuckets(remoteValues);
  const ordered = Object.entries(records).sort(([leftWord, left], [rightWord, right]) =>
    right[5] - left[5] || Number(!!remoteRecords[rightWord]) - Number(!!remoteRecords[leftWord]) ||
    left[1] - right[1] || compareText(leftWord, rightWord));
  for (const [word, record] of ordered) {
    if (sameRecord(record, remoteRecords[word])) continue;
    const key = bucketFor(word);
    const oldValue = values[key];
    const bucket = oldValue && typeof oldValue === "object" && !Array.isArray(oldValue) ? { ...oldValue } : {};
    bucket[word] = record;
    const nextBytes = bytesFor(key, bucket);
    const previousBytes = oldValue === undefined ? 0 : bytesFor(key, oldValue);
    const nextTotal = totalBytes - previousBytes + nextBytes;
    if (nextBytes > limits.item || nextTotal > limits.total || oldValue === undefined && itemCount >= limits.items) continue;
    values[key] = bucket;
    writes[key] = bucket;
    totalBytes = nextTotal;
    if (oldValue === undefined) itemCount++;
  }
  return { writes, values, totalBytes };
}
