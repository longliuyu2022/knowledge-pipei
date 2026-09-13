import { mkdirSync, writeFileSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashAdminPassword } from '../server/admin.js';
import { projectRoot } from '../server/config.js';

// Passwords enter through stdin only; stdout never contains the password or hash.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--file' || !isAbsolute(args[1])) throw new Error('用法：通过标准输入传入密码，指定 --file /absolute/private/path');
  const requested = resolve(args[1]);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const file = resolve(realpathSync(dirname(requested)), requested.slice(dirname(requested).length + 1));
  const withinProject = relative(realpathSync(projectRoot), file);
  if (!withinProject.startsWith('..' + '/') && !isAbsolute(withinProject)) throw new Error('哈希文件必须位于项目仓库外');
  let password = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    password += chunk.toString('utf8');
    if (Buffer.byteLength(password) > 512) throw new Error('密码长度应为 16–128 个字符');
  }
  password = password.replace(/\r?\n$/, '');
  if (password.length < 16 || password.length > 128 || /[\r\n\0]/.test(password)) throw new Error('密码长度应为 16–128 个字符，不能包含换行或空字符');
  const encoded = await hashAdminPassword(password);
  const temporary = file + '.new-' + randomBytes(8).toString('hex');
  writeFileSync(temporary, encoded + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  console.log('管理员密码哈希已保存。重启服务后生效，已有管理会话将失效。');
} catch (error) {
  console.error(error?.code ? '无法保存管理员凭证，请检查文件目录与权限。' : error.message);
  process.exitCode = 1;
}
