import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultDbPath, openDb } from '../src/db';

const path = process.argv[2] ?? defaultDbPath();
mkdirSync(dirname(resolve(path)), { recursive: true });
const { close } = openDb(path);
close();
console.log(`Kuncen: schema up to date at ${resolve(path)}`);
