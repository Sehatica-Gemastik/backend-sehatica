/**
 * Reset data PTM / kuisioner (mulai dari nol untuk E2E).
 * Run: bun run db:clear-questionnaire-logs
 */
import { db } from '../db';
import {
  userDailyCompliance,
  userDailyQuestionnaires,
  userWeeklyCheckins,
} from '../db/schema';

async function main() {
  await db.delete(userDailyQuestionnaires);
  await db.delete(userDailyCompliance);
  await db.delete(userWeeklyCheckins);
  console.log('PTM data cleared: questionnaires, compliance, weekly checkins.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
