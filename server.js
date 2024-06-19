const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath)
const { admin, db, storage } = require('./firebaseAdmin');
const authenticate = require('./authMiddleware');
const cors = require('cors');
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const { v4: uuidv4 } = require('uuid');
// const {rootStorage} = require('./firebaseClient');

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const ensureTmpDirExists = () => {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir);
    }
};

const checkStorageLimit = async (userId, newFileSize) => {
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return { status: 'error', message: 'User document not found' };
  }

  const userData = userDoc.data();
  const storageLimit = 100 * 1024 * 1024; // 100 MB limit
  const newStorageUsage = (userData.usedStorageMB || 0) + newFileSize;

  if (newStorageUsage > storageLimit) {
    return { status: 'error', message: 'You exceeded your storage limit.' };
  }

  await userRef.update({
    usedStorageMB: newStorageUsage,
  });

  return { status: 'success', newStorageUsage };
};

// Ensure all routes below this line require authentication
app.use(authenticate);

app.get('/hello', async (req, res) => {
    return res.status(200).send('Hello');
});

app.post('/upload-lyrics', upload.single('file'), async (req, res) => {
  try {
    const { albumId, songId, trackId, trackName } = req.body;
    const newFile = req.file;
    const userId = req.user.uid;

    if (!newFile) {
      return res.status(400).send('No file uploaded');
    }

    const newFileSize = newFile.size;
    const storageCheck = await checkStorageLimit(userId, newFileSize);
    if (storageCheck.status === 'error') {
        console.log('Client exceeded storage limit')
      return res.status(507).json({ message: storageCheck.message });
    }

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


// Helper function to extract file path from URL
const getFilePathFromURL = (url) => {
    console.log('GETTING: ', url);
  
    // Handle Firebase Storage URL
    let match = url.match(/\/o\/(.*?)\?/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  
    // Handle Google Cloud Storage URL
    match = url.match(/https:\/\/storage\.googleapis\.com\/[^\/]+\/(.*)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  
    throw new Error(`Invalid file URL: ${url}`);
  };
  
  app.post('/sharecode', async (req, res) => {
    try {
      const { sharecode } = req.body;
      const userId = req.user.uid;
  
      if (!sharecode) {
        throw new Error('No share code provided.');
      }
  
      const shareRef = db.collection('shares').doc(sharecode);
      const shareDoc = await shareRef.get();
  
      if (!shareDoc.exists) {
        throw new Error('Share code not found.');
      }
  
      const shareData = shareDoc.data();
  
      const addUserToAlbum = async (albumId) => {
        const albumRef = db.collection('albums').doc(albumId);
        const albumDoc = await albumRef.get();
  
        if (!albumDoc.exists) {
          throw new Error('Album not found.');
        }
  
        const albumData = albumDoc.data();
        if(albumData.ownerId && albumData.ownerId === userId){
            throw new Error ('You are the owner.')
        }

        if (albumData.sharedWith && albumData.sharedWith.includes(userId)) {
          throw new Error('User is already added to the album.');
        }
  
        await albumRef.update({
          sharedWith: admin.firestore.FieldValue.arrayUnion(userId)
        });
  
        // Add user to usedBy array in share document
        await shareRef.update({
          usedBy: admin.firestore.FieldValue.arrayUnion(userId)
        });
      };
  
      const getSongsInAlbum = async (albumId) => {
        const songsRef = db.collection('albums').doc(albumId).collection('songs');
        const songsSnapshot = await songsRef.get();
        return songsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      };
  
      const addUserToSong = async (albumId, songId) => {
        const songRef = db.collection('albums').doc(albumId).collection('songs').doc(songId);
        await songRef.update({
          sharedWith: admin.firestore.FieldValue.arrayUnion(userId)
        });
      };
  
      const addUserToFiles = async (tracks, lrcs) => {
        if (tracks) {
          for (const track of tracks) {
            const filePath = getFilePathFromURL(track.src);
            console.log("File Path: ",filePath)
            const fileRef = storage.file(filePath);
            const [fileMetadata] = await fileRef.getMetadata();
            const sharedWithMeta = fileMetadata.metadata.sharedWith || '';
            const newSharedWithMeta = sharedWithMeta ? `${sharedWithMeta},${userId}` : userId;
            await fileRef.setMetadata({
              metadata: {
                sharedWith: newSharedWithMeta
              }
            });
          }
        }
  
        if (lrcs) {
          for (const lrc of lrcs) {
            const filePath = getFilePathFromURL(lrc.lrc);
            const fileRef = storage.file(filePath);
            const [fileMetadata] = await fileRef.getMetadata();
            const sharedWithMeta = fileMetadata.metadata.sharedWith || '';
            const newSharedWithMeta = sharedWithMeta ? `${sharedWithMeta},${userId}` : userId;
            await fileRef.setMetadata({
              metadata: {
                sharedWith: newSharedWithMeta
              }
            });
          }
        }
      };
  
      for (const album of shareData.albums) {
        await addUserToAlbum(album);
        const songsData = await getSongsInAlbum(album);
        for (const song of songsData) {
          await addUserToSong(album, song.id);
          await addUserToFiles(song.tracks, song.lrcs);
        }
      }
  
      res.status(200).json({result: 'success', message: 'Album added successfully'});
    } catch (error) {
      console.error(error);
      if(error.message === 'User is owner'){
        res.status(409).json({result: 'error', message: 'User is owner'})
      }
      res.status(500).json({result: 'error', message: error.message});
    }
  });

  app.post('/upload-audio', upload.array('files', 15), async (req, res) => {
    try {
      console.log("Upload Request triggered", req.body, "User Id: ", req.user.uid);
      const { albumId, songId, trackNames, trackNumbers, songName, albumName, songNumber } = req.body;
      const files = req.files;
      const userId = req.user.uid;
      console.log("Track numbers: ", trackNumbers);
      const fullUser = admin.auth().getUser(userId);
      const userName = (await fullUser).displayName;
  
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
  
      ensureTmpDirExists();
  
      // Get album data
      const albumRef = db.collection('albums').doc(albumId);
      const albumDoc = await albumRef.get();
      const albumData = albumDoc.data();
      const sharedWith = albumData.sharedWith ? albumData.sharedWith : []; // Array of users the song is shared with
  
      // Get song data
      const songRef = db.collection('albums').doc(albumId).collection('songs').doc(songId);
      const songDoc = await songRef.get();
  
      // Array to accumulate track data
      const trackDataArray = [];
  
      const promises = files.map(async (file, index) => {
        const tempFilePath = path.join(__dirname, 'tmp', file.originalname);
        await fs.promises.writeFile(tempFilePath, file.buffer);
  
        const compressedFilePath = path.join(__dirname, 'tmp', `compressed-${file.originalname}`);
        return new Promise((resolve, reject) => {
          console.log("Compressing file: ", file.originalname);
          ffmpeg(tempFilePath)
            .audioBitrate('96k')
            .save(compressedFilePath)
            .on('end', async () => {
              try {
                const compressedFile = await fs.promises.readFile(compressedFilePath);
                const compressedFileSize = compressedFile.length;
  
                const storageCheck = await checkStorageLimit(userId, compressedFileSize);
                if (storageCheck.status === 'error') {
                  console.log(`Client ${userId} exceeded storage limit`);
                  resolve({ status: 'error', message: storageCheck.message });
                  return;
                }
  
                const trackName = trackNames[index];
                const trackNumber = trackNumbers[index];
                const newFileName = `${songId}_${trackName}.mp3`;
                const file = storage.file(`sounds/${albumId}/${songId}/${newFileName}`);
                console.log('Saving file to storage: ', file.id);
                const metadata = {
                  metadata: {
                    contentType: 'audio/mpeg',
                    ownerId: userId,
                    sharedWith: sharedWith.join(','),
                  }
                };
                await file.save(compressedFile, metadata);
                console.log("Setting metadata");
                await file.setMetadata(metadata);
  
                const newSrc = file.publicUrl();
  
                const trackData = {
                  id: uuidv4(),
                  name: trackName,
                  src: newSrc,
                  number: trackNumber,
                  ownerId: userId,
                  ownerName: userName
                };
  
                // Accumulate track data
                trackDataArray.push(trackData);
  
                resolve({ status: 'success' });
              } catch (error) {
                reject(error);
              } finally {
                fs.promises.unlink(tempFilePath).catch(console.error);
                fs.promises.unlink(compressedFilePath).catch(console.error);
                console.log('Upload successful.');
              }
            })
            .on('error', (error) => {
              console.error("Upload failed: ", error.message);
              reject(error);
            });
        });
      });
  
      const results = await Promise.all(promises);
  
      const errors = results.filter(result => result.status === 'error');
      if (errors.length > 0) {
        return res.status(507).json({ message: errors[0].message });
      }
  
      // Perform a single update to Firestore with all track data
      if (songDoc.exists) {
        await songRef.update({
          tracks: admin.firestore.FieldValue.arrayUnion(...trackDataArray)
        });
        console.log("Updated existing song with new tracks");
      } else {
        const songData = {
          name: songName,
          number: songNumber,
          ownerId: userId,
          sharedWith: sharedWith,
          tracks: trackDataArray,
          lrcs: []
        };
        await songRef.set(songData);
        console.log("Created new song with tracks");
      }
  
      res.status(200).json({ message: 'Audio files uploaded and compressed successfully' });
    } catch (error) {
      console.error("Error: ", error);
      res.status(500).json({ error: error.message });
    }
  });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
