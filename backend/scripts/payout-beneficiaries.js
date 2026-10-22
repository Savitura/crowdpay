require('dotenv').config();
const db = require('../src/config/database');
const service = require('../src/services/payoutBeneficiaries');
const commands = {
  request: service.requestBeneficiary,
  approve: service.approveBeneficiary,
  revoke: service.revokeBeneficiary,
};
const [command, campaign, destination, actor] = process.argv.slice(2);
async function main() {
  if (!commands[command] || !campaign || !destination || !actor) {
    throw new Error(
      'Usage: node scripts/payout-beneficiaries.js request|approve|revoke <campaign> <destination> <actor-user-id>'
    );
  }
  return commands[command](db, campaign, destination, actor);
}
main()
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => (db.pool || db).end());
