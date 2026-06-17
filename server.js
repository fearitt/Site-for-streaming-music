const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;
const YT_DLP = path.join(__dirname, 'yt-dlp.exe');
const FFMPEG = path.join(__dirname, 'ffmpeg.exe');

const db = new Database('tracks.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT DEFAULT 'Unknown',
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|wav|flac|ogg|aac|m4a|wma)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.get('/api/tracks', (req, res) => {
  const tracks = db.prepare('SELECT * FROM tracks ORDER BY created_at DESC').all();
  res.json(tracks);
});

app.post('/api/tracks', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const id = uuidv4();
  const title = req.body.title || req.file.originalname.replace(/\.[^/.]+$/, '');
  const artist = req.body.artist || 'Unknown';

  const stmt = db.prepare('INSERT INTO tracks (id, title, artist, filename, filepath) VALUES (?, ?, ?, ?, ?)');
  stmt.run(id, title, artist, req.file.filename, req.file.path);

  res.json({ id, title, artist, filename: req.file.filename });
});

app.delete('/api/tracks/:id', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const fs = require('fs');
  if (fs.existsSync(track.filepath)) {
    fs.unlinkSync(track.filepath);
  }

  db.prepare('DELETE FROM tracks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/tracks/import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const id = uuidv4();
  const outputTemplate = path.join(__dirname, 'uploads', `${id}_%(title)s`);

  try {
    await runYtDlp([
      url,
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', FFMPEG,
      '-o', `${outputTemplate}.%(ext)s`,
      '--no-playlist',
      '--no-warnings',
      '--print', 'after_move:filepath'
    ]);
  } catch (err) {
    return res.status(500).json({ error: 'Download failed: ' + err.message });
  }

  const files = fs.readdirSync(path.join(__dirname, 'uploads'));
  const importedFile = files.find(f => f.startsWith(id));
  if (!importedFile) return res.status(500).json({ error: 'File not found after download' });

  const filepath = path.join(__dirname, 'uploads', importedFile);
  let title = importedFile
    .replace(id + '_', '')
    .replace(/\.mp3$/i, '')
    .replace(/_/g, ' ');

  const stmt = db.prepare('INSERT INTO tracks (id, title, artist, filename, filepath) VALUES (?, ?, ?, ?, ?)');
  stmt.run(id, title, 'YouTube Import', importedFile, filepath);

  res.json({ id, title, artist: 'YouTube Import', filename: importedFile });
});

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(YT_DLP, args, { cwd: __dirname, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
    proc.stderr.on('data', (data) => process.stderr.write(data));
  });
}

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
