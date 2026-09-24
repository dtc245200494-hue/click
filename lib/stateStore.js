import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  load() {
    try {
      if (!fs.existsSync(this.filename)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      return Array.isArray(parsed?.campaigns) ? parsed.campaigns : [];
    } catch (error) {
      console.error('[state] load failed:', error.message);
      return [];
    }
  }

  save(campaigns) {
    const payload = JSON.stringify({ version: 1, savedAt: Date.now(), campaigns }, null, 2);
    const tmp = `${this.filename}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filename);
  }
}
