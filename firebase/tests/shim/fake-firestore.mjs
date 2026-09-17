// A tiny in-memory Firestore for unit-testing api-shim.js: supports the subset
// the shim uses — collection/doc/query/where(==, array-contains)/orderBy/limit,
// getDoc/getDocs/getCountFromServer/updateDoc.

export function makeFakeFirestore(seed = {}) {
  const store = {};
  for (const [col, docs] of Object.entries(seed)) {
    store[col] = {};
    for (const [id, data] of Object.entries(docs)) store[col][id] = { ...data };
  }
  const calls = { getDocs: [], getDoc: [], updateDoc: [], count: [] };

  const db = { __db: true };
  const collection = (_db, name) => ({ __col: name });
  const doc = (_db, col, id) => ({ __ref: [col, id] });
  const where = (f, op, v) => ({ __where: [f, op, v] });
  const orderBy = (f, dir = "asc") => ({ __order: [f, dir] });
  const limit = (n) => ({ __limit: n });
  const query = (src, ...parts) => {
    const base = src.__q ? src : { __q: src.__col, wheres: [], orders: [], lim: null };
    const q = { __q: base.__q, wheres: [...base.wheres], orders: [...base.orders], lim: base.lim };
    for (const p of parts) {
      if (p.__where) q.wheres.push(p.__where);
      else if (p.__order) q.orders.push(p.__order);
      else if (p.__limit != null) q.lim = p.__limit;
    }
    return q;
  };

  function runQuery(q) {
    let rows = Object.entries(store[q.__q] || {}).map(([id, data]) => ({ id, data }));
    for (const [f, op, v] of q.wheres) {
      rows = rows.filter(({ data }) => {
        const cur = data[f];
        if (op === "==") return cur === v;
        if (op === "!=") return cur !== v;
        if (op === "in") return Array.isArray(v) && v.includes(cur);
        if (op === "array-contains") return Array.isArray(cur) && cur.includes(v);
        if (op === ">=") return cur >= v;
        if (op === "<=") return cur <= v;
        return true;
      });
    }
    for (const [f, dir] of [...q.orders].reverse()) {
      rows.sort((a, b) => {
        const av = a.data[f], bv = b.data[f];
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "desc" ? -c : c;
      });
    }
    if (q.lim != null) rows = rows.slice(0, q.lim);
    return rows;
  }

  const snap = (row) => ({ id: row.id, exists: () => !!row.data, data: () => row.data });
  const getDocs = async (q) => {
    calls.getDocs.push(q);
    return { docs: runQuery(q).map(snap), get size() { return runQuery(q).length; } };
  };
  const getDoc = async (ref) => {
    calls.getDoc.push(ref.__ref);
    const [col, id] = ref.__ref;
    const data = store[col]?.[id];
    return { id, exists: () => !!data, data: () => data };
  };
  const getCountFromServer = async (q) => {
    calls.count.push(q);
    return { data: () => ({ count: runQuery(q).length }) };
  };
  const updateDoc = async (ref, patch) => {
    calls.updateDoc.push([ref.__ref, patch]);
    const [col, id] = ref.__ref;
    store[col] = store[col] || {};
    store[col][id] = { ...(store[col][id] || {}), ...patch };
  };

  return {
    db, store, calls,
    fs: { collection, doc, getDoc, getDocs, getCountFromServer, query, where, orderBy, limit, updateDoc },
  };
}
