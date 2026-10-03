import { Notebook } from "../extension/core/notebook.js";
import { bytesFor, LIMITS } from "../extension/core/model.js";

export function memoryArea(initial = {}, limits = null) {
  return {
    data: structuredClone(initial),
    writes: 0,
    failure: null,
    readFailure: null,
    async get(key) {
      if (this.readFailure) throw new Error(this.readFailure);
      return structuredClone(key === null ? this.data : { [key]: this.data[key] });
    },
    async set(values) {
      if (this.failure) throw new Error(this.failure);
      const next = { ...this.data, ...structuredClone(values) };
      if (limits) {
        if (Object.keys(next).length > limits.items || Object.entries(next).reduce((total, [key, value]) => total + bytesFor(key, value), 0) > limits.total) throw new Error("QUOTA_BYTES quota exceeded");
        if (Object.entries(next).some(([key, value]) => bytesFor(key, value) > limits.item)) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
      this.data = next;
      this.writes++;
    },
  };
}

export function device(actor, { local = memoryArea(), sync = memoryArea({}, LIMITS), limits = LIMITS, timestamp = 1000 } = {}) {
  let clock = timestamp;
  const notebook = new Notebook({ local, sync, actor: () => actor, now: () => ++clock, limits });
  return { notebook, local, sync, dispatch: command => notebook.dispatch(command) };
}

export async function exchange(source, target) {
  const incoming = structuredClone(source.sync.data);
  const previous = target.sync.data;
  target.sync.data = incoming;
  const changes = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    changes[key] = { oldValue: previous[key], newValue: incoming[key] };
  }
  return target.dispatch({ type: "sync", changes });
}
