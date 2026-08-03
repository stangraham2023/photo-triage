import { generateFixtures } from './generate.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated');

export default async function setup() {
  await generateFixtures(FIXTURE_DIR);
}
