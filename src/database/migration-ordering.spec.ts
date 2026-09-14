import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migrations must be totally ordered.
 *
 * TypeORM sorts by the timestamp in the class name and records each by name. Two migrations
 * sharing a timestamp leave the order between them undefined — it worked here only because
 * the two happened to be independent, and the next pair might add a column and then index it.
 * A fresh install is the one place nobody is watching, and it is exactly where this breaks.
 */
describe('migration ordering', () => {
  const dir = join(__dirname, 'migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('gives every migration its own timestamp', () => {
    const byTimestamp = new Map<string, string[]>();
    for (const file of files) {
      const timestamp = /^(\d+)-/.exec(file)?.[1];
      expect(timestamp).toBeDefined();
      byTimestamp.set(timestamp!, [...(byTimestamp.get(timestamp!) ?? []), file]);
    }

    const clashes = [...byTimestamp.entries()].filter(([, names]) => names.length > 1);
    expect(clashes.map(([timestamp, names]) => `${timestamp}: ${names.join(', ')}`)).toEqual([]);
  });

  it('names each class for its own file, so the recorded name matches the order', () => {
    const mismatched = files.filter(file => {
      const [timestamp, rest] = [/^(\d+)-/.exec(file)?.[1], file.replace(/^\d+-/, '').replace(/\.ts$/, '')];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require(join(dir, file)) as Record<string, unknown>;
      return !Object.keys(module).includes(`${rest}${timestamp}`);
    });
    expect(mismatched).toEqual([]);
  });
});
