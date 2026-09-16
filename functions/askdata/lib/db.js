'use strict';

/**
 * Where reads come from.
 *
 *   datastore  Catalyst Data Store via ZCQL - the real thing
 *   seed       lib/seeddb.js - the same rows the seeder would load, served
 *              from memory, for a test deployment whose Data Store cannot be
 *              written to (see seeddb.js for why)
 *
 * One switch, ASKDATA_DATA_SOURCE, read at call time so /health can report
 * it. The audit log is never routed here: SupportQueryLog is real and stays
 * in the Data Store whichever source answers questions.
 */


function source() {
  return String(process.env.ASKDATA_DATA_SOURCE || 'datastore').toLowerCase() === 'seed' ? 'seed' : 'datastore';
}

async function query(catalystApp, zcql) {
  // Required lazily: seeddb -> seed -> replica -> db would otherwise be a cycle
  // that hands replica an empty module. Only the seed source ever pays for it.
  if (source() === 'seed') return require('./seeddb').execute(zcql).rows;
  return catalystApp.zcql().executeZCQLQuery(zcql);
}

module.exports = { query, source };
