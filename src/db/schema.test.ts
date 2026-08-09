import { expect, test } from 'bun:test';
import * as schema from './schema';

test('backend schema does not expose general health persistence', () => {
  const exports = Object.keys(schema);
  expect(exports).not.toContain('medicalRecords');
  expect(exports).not.toContain('schedules');
  expect(exports).not.toContain('chatMessages');
  expect(exports).not.toContain('dailyInsights');
  expect(exports).not.toContain('verifRequests');
});
