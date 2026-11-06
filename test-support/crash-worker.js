import { openDatabase } from '../src/db.js';

const [filename, taskId] = process.argv.slice(2);
const db = openDatabase(filename);
db.exec('BEGIN IMMEDIATE');
db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId);
process.exit(0);
