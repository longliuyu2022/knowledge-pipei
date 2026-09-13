import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/config.js';

const file = resolve(projectRoot, 'artifacts/browser-suite.json');
mkdirSync(resolve(projectRoot, 'artifacts'), { recursive: true });
const report = { status: 'running', startedAt: new Date().toISOString(), suites: [] };
const save = () => writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
save();
try {
  for (const suite of ['discovery', 'profile', 'connections']) {
    const started = Date.now();
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [`scripts/browser-${suite}.mjs`], { cwd: projectRoot, stdio: 'inherit', env: process.env });
      child.on('error', reject); child.on('exit', value => done(value));
    });
    report.suites.push({ name: suite, status: code === 0 ? 'passed' : 'failed', elapsedMs: Date.now() - started }); save();
    if (code !== 0) throw new Error(`${suite} browser suite failed`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); }
