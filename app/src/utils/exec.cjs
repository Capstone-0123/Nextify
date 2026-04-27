const { spawn } = require('child_process');

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? true,
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}`));
    });
  });
}

function startCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: options.shell ?? true,
    stdio: options.stdio ?? 'inherit',
  });

  return child;
}

module.exports = { runCommand, startCommand };

