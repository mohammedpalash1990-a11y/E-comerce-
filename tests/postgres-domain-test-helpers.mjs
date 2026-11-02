export function createScriptedDatabase(handler) {
  const calls = [];
  let transactionCount = 0;
  const database = {
    q(sql) {
      return {
        get: async (...params) => { calls.push({ method: 'get', sql, params }); return handler({ method: 'get', sql, params, calls }); },
        all: async (...params) => { calls.push({ method: 'all', sql, params }); return handler({ method: 'all', sql, params, calls }) ?? []; },
        run: async (...params) => { calls.push({ method: 'run', sql, params }); return handler({ method: 'run', sql, params, calls }) ?? { changes: 1, rowCount: 1 }; }
      };
    },
    async tx(callback) {
      transactionCount += 1;
      return callback();
    },
    get calls() { return calls; },
    get transactionCount() { return transactionCount; }
  };
  return database;
}
