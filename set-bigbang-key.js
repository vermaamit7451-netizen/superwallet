const fs = require('fs');
const path = require('path');
const readline = require('readline');

const envPath = path.join(__dirname, '.env');

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (ch === '\u0003') process.exit(1);
      if (ch === '\u007f') {
        if (value.length) value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  console.log('SuperWallet - BigBang Sandbox Key Setup');
  console.log('Paste your BigBang sandbox key (starts with ek_test_). The key will not be printed.');
  const key = await askHidden('BigBang API key: ');

  if (!key.startsWith('ek_test_') || key.length < 12) {
    console.error('Invalid format. A BigBang sandbox key must start with ek_test_.');
    process.exit(1);
  }

  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `BIGBANG_API_KEY=${key}`;
  if (/^BIGBANG_API_KEY=.*$/m.test(env)) {
    env = env.replace(/^BIGBANG_API_KEY=.*$/m, line);
  } else {
    env = env.replace(/\s*$/, '') + `\n${line}\n`;
  }
  fs.writeFileSync(envPath, env, 'utf8');
  console.log('Saved BIGBANG_API_KEY to .env.');
  console.log('Now run: npm run dev');
})();
