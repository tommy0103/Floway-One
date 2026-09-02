import { installPersonalLogging } from '../../src/personal-logging.ts';

const [logsDir, maxBytesValue, maxFilesValue] = process.argv.slice(2);
if (logsDir === undefined || maxBytesValue === undefined || maxFilesValue === undefined) {
  throw new Error('Expected logs directory, maximum bytes, and maximum files');
}

installPersonalLogging(logsDir, {
  maxBytes: Number(maxBytesValue),
  maxFiles: Number(maxFilesValue),
});

for (let index = 0; index < 20; index++) {
  console.log(`application stdout ${index} ${'x'.repeat(32)}`);
  process.stdout.write(`raw stdout ${index} ${'y'.repeat(32)}\n`);
  console.error(`application stderr ${index} ${'a'.repeat(32)}`);
  process.stderr.write(`raw stderr ${index} ${'b'.repeat(32)}\n`);
}
console.log('final application stdout');
console.error('final application stderr');
