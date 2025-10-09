import { buildDocsFromData, buildRagIndex } from './rag.js';
import fs from 'fs';
import path from 'path';

export function createAgent({ dataDir, listRooms, loadRoomTables, loadWeather, callGeminiChat }) {
