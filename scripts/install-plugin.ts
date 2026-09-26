import 'dotenv/config';
import path from 'node:path';
import { Plugins } from '../server/plugins.js';
const manager = new Plugins(path.resolve(process.env.STUDIO_DATA_DIR || '.studio'));
const source = process.argv[2];
if (!source) throw new Error('CadFlow is built in. To add an optional extension, provide its GitHub repository URL.');
const plugin = await manager.install(source);
console.log(`Installed ${plugin.name} (${plugin.revision.slice(0, 12)}), ${plugin.skills.length} skill(s).`);
