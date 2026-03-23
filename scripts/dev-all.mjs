import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = new Set();
let shuttingDown = false;

const spawnProcess = (name, command, args) => {
  const child = isWindows
    ? spawn('cmd.exe', ['/d', '/s', '/c', `${command} ${args.join(' ')}`], {
        stdio: 'inherit',
        env: process.env,
      })
    : spawn(command, args, {
        stdio: 'inherit',
        env: process.env,
      });

  children.add(child);

  child.on('exit', code => {
    children.delete(child);

    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited with code ${code ?? 'unknown'}. Stopping dev session.`);
      shutdown(code ?? 1);
    }
  });

  child.on('error', error => {
    if (!shuttingDown) {
      console.error(`Failed to start ${name}:`, error.message);
      shutdown(1);
    }
  });

  return child;
};

const terminateChild = child => {
  if (child.killed) {
    return;
  }

  if (isWindows) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });

    killer.on('exit', () => child.kill());
    return;
  }

  child.kill('SIGTERM');
};

const shutdown = exitCode => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    terminateChild(child);
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 300);
};

spawnProcess('frontend', 'npm.cmd', [
  'run',
  'dev:web',
  '--',
  '--host',
  'localhost',
]);

spawnProcess('backend', 'npm.cmd', ['run', 'server']);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
