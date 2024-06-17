const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { admin, db, storage } = require('./firebaseAdmin');
const authenticate = require('./authMiddleware');
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const checkStorageLimit = async (userId, newFileSize) => {
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error('User document not found');
  }

  const userData = userDoc.data();
  const storageLimit = 100 * 1024 * 1024; // 100 MB limit
  const newStorageUsage = (userData.usedStorageMB || 0) + newFileSize;

  if (newStorageUsage > storageLimit) {
    throw new Error('Storage limit exceeded');
  }

  await userRef.update({
    usedStorageMB: newStorageUsage,
  });

  return newStorageUsage;
};

// Ensure all routes below this line require authentication
app.use(authenticate);

// Endpoint to upload lyrics
app.post('/upload-lyrics', upload.single('file'), async (req, res) => {
  try {
    const { albumId, songId, trackId, trackName } = req.body;
    const newFile = req.file;
    const userId = req.user.uid;

    if (!newFile) {
      return res.status(400).send('No file uploaded');
    }

    const newFileSize = newFile.size;
    await checkStorageLimit(userId, newFileSize);

    const newFileName = `${songId}_${trackName}_track-${trackId}.lrc`;
    const file = storage.file(`sounds/${albumId}/${songId}/${newFileName}`);
    await file.save(newFile.buffer, {
      metadata: { contentType: 'text/plain' },
    });

    const newSrc = file.publicUrl();
    const songRef = db.collection('albums').doc(albumId).collection('songs').doc(songId);
    const songDoc = await songRef.get();
    const songData = songDoc.data();

    const existingLrc = songData.lrcs?.find((lrc) => lrc.trackId === parseInt(trackId));
    if (existingLrc) {
      await storage.file(existingLrc.lrc).delete();
    }

    const updatedLrcs = songData.lrcs || [];
    const lrcIndex = updatedLrcs.findIndex((lrc) => lrc.trackId === parseInt(trackId));

    if (lrcIndex > -1) {
      updatedLrcs[lrcIndex].lrc = newSrc;
    } else {
      updatedLrcs.push({ trackId: parseInt(trackId), trackName, lrc: newSrc });
    }

    await songRef.update({ lrcs: updatedLrcs });
    res.status(200).send('LRC updated successfully');
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Endpoint to add people to sharedWith array
app.post('/share', async (req, res) => {
  try {
    const { albumId, songId, shareWithUserId } = req.body;

    if (songId) {
      const songRef = db.collection('albums').doc(albumId).collection('songs').doc(songId);
      await songRef.update({
        sharedWith: admin.firestore.FieldValue.arrayUnion(shareWithUserId),
      });
    } else {
      const albumRef = db.collection('albums').doc(albumId);
      await albumRef.update({
        sharedWith: admin.firestore.FieldValue.arrayUnion(shareWithUserId),
      });
    }

    res.status(200).send('Shared successfully');
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Endpoint to handle audio file compression and upload
app.post('/upload-audio', upload.single('file'), async (req, res) => {
  try {
    const { albumId, songId, trackName } = req.body;
    const newFile = req.file;
    const userId = req.user.uid;

    if (!newFile) {
      return res.status(400).send('No file uploaded');
    }

    const tempFilePath = `/tmp/${newFile.originalname}`;
    await fs.promises.writeFile(tempFilePath, newFile.buffer);

    const compressedFilePath = `/tmp/compressed-${newFile.originalname}`;
    ffmpeg(tempFilePath)
      .audioBitrate('96k')
      .save(compressedFilePath)
      .on('end', async () => {
        const compressedFile = await fs.promises.readFile(compressedFilePath);
        const compressedFileSize = compressedFile.length;
        await checkStorageLimit(userId, compressedFileSize);

        const newFileName = `${songId}_${trackName}.mp3`;
        const file = storage.file(`sounds/${albumId}/${songId}/${newFileName}`);
        await file.save(compressedFile, {
          metadata: { contentType: 'audio/mpeg' },
        });

        const newSrc = file.publicUrl();
        const songRef = db.collection('albums').doc(albumId).collection('songs').doc(songId);
        const songDoc = await songRef.get();
        const songData = songDoc.data();

        const track = songData.tracks.find((t) => t.name === trackName);
        if (track) {
          await storage.file(track.src).delete();
          track.src = newSrc;
        } else {
          songData.tracks.push({
            name: trackName,
            src: newSrc,
          });
        }

        await songRef.update({ tracks: songData.tracks });
        res.status(200).send('Audio file uploaded and compressed successfully');
      })
      .on('error', (error) => {
        res.status(500).send(error.message);
      });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
