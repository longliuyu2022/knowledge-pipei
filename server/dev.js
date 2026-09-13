import { spawn } from 'node:child_process';
import { projectRoot } from './config.js';

const env = { ...process.env, SOUL_PUBLIC_ORIGIN: '', TONGZHI_PUBLIC_ORIGIN: '' };
const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: projectRoot, stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: projectRoot, stdio: 'inherit', env }),
];
let exiting = false;
function stop(code = 0) {
  if (exiting) return; exiting = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
for (const child of children) child.on('exit', code => stop(code || 0));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
