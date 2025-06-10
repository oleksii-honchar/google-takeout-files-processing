/**
 * Process Google Takeout files by updating EXIF data, renaming them, and
 * copying them to a new destination folder.
 *
 * This script reads from a source directory, and writes the processed files
 * to a new target directory, leaving the original files untouched.
 *
 * It performs the following steps:
 * 1. Downloads each media file to inspect its true file type.
 * 2. For each media file, it finds its corresponding metadata .json file.
 * 3. It reads the `photoTakenTime` from the JSON.
 * 4. Updates the file's EXIF "DateTimeOriginal" tag locally.
 * 5. Recreates the album folder structure in `REMOTE_PROCESSED_PATH`.
 * 6. Uploads the corrected file with its proper, timestamp-based name and
 *    correct file extension to the new target path.
 * 7. If an "-edited" file is processed, the original version is not copied.
 *
 * NOTE: This is much slower than simple renaming due to file transfers.
 */

import path from "path";
import os from "os";
import fs from "fs/promises";
import SambaClient from "samba-client";
import { ExifTool } from "exiftool-vendored";

const IS_DRY_RUN = false;
const SERVER_NAME = "192.168.1.121";
const SHARE_NAME = "Data";
const REMOTE_SOURCE_PATH = "!Pictures/Google Takeout 2025-05-20/merged";
const REMOTE_PROCESSED_PATH = "!Pictures/Google Takeout 2025-05-20/processed";

const exiftool = new ExifTool();
const smbClient = new SambaClient({
  address: `//${SERVER_NAME}/${SHARE_NAME}`,
  username: process.env.SMB_USERNAME || "guest",
  password: process.env.SMB_PASSWORD || "",
  domain: "WORKGROUP",
});

const formatDate = (date: Date): string => {
  const YYYY = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const DD = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD}_${hh}-${mm}-${ss}`;
};

const formatExifDate = (date: Date): string => {
  const YYYY = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const DD = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${YYYY}:${MM}:${DD} ${hh}:${mm}:${ss}`;
};

const processDirectory = async (sourceDir: string, targetDir: string) => {
  console.log(`\nProcessing source: ${sourceDir}`);
  console.log(`Writing to target: ${targetDir}`);

  let existingTargetFiles = new Set<string>();
  try {
    const listTargetPath = path.join(targetDir, "*").replace(/\\/g, "/");
    const targetDirResult = await smbClient.dir(listTargetPath);
    const targetEntries = targetDirResult.toString().split('\n').filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.includes("blocks of size");
    });
    existingTargetFiles = new Set(targetEntries.map(line => line.trim().split(/\s{2,}/)[0]));
  } catch (e) {
    console.log(`- Target directory ${targetDir} is new or empty. Ensuring it exists.`);
    if (!IS_DRY_RUN) {
      try {
        await smbClient.mkdir(targetDir);
      } catch (mkdirError) {
        // Ignore error, it likely already exists but was empty.
      }
    }
  }

  const listPath = path.join(sourceDir, "*").replace(/\\/g, "/");
  const dirResult = await smbClient.dir(listPath);
  const allEntries = dirResult.toString().split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.includes("blocks of size");
  });
  const fileNames = new Set(allEntries.map(line => line.trim().split(/\s{2,}/)[0]));

  const originalsToSkip = new Set<string>();
  for (const name of fileNames) {
    if (name.toLowerCase().includes("-edited")) {
      originalsToSkip.add(name.replace(/-edited/i, ""));
    }
  }

  for (const line of allEntries) {
    const isDirectory = line.includes(" D ");
    const entryName = line.trim().split(/\s{2,}/)[0];
    const sourcePath = path.join(sourceDir, entryName).replace(/\\/g, "/");

    if (isDirectory) {
      if (entryName === "." || entryName === "..") continue;
      const newTargetDir = path.join(targetDir, entryName).replace(/\\/g, "/");
      await processDirectory(sourcePath, newTargetDir);
      continue;
    }

    if (entryName.toLowerCase().endsWith(".json") || originalsToSkip.has(entryName)) {
      if (originalsToSkip.has(entryName)) console.log(`- Skipping original with edited version: ${entryName}`);
      else console.log(`- Skipping: ${entryName}`);
      continue;
    }

    const tempFilePath = path.join(os.tmpdir(), entryName);
    try {
      await smbClient.getFile(sourcePath, tempFilePath);

      const jsonFileName = [...fileNames].find(f => f.startsWith(entryName) && f.endsWith(".json"));
      if (!jsonFileName) {
        console.log(`- No metadata for: ${entryName}, copying as-is.`);
        if (existingTargetFiles.has(entryName)) {
          console.log(`- Skipping already existing file: ${entryName}`);
          continue;
        }
        const targetPath = path.join(targetDir, entryName).replace(/\\/g, "/");
        if (IS_DRY_RUN) {
          console.log(`  (Dry Run) Would copy ${sourcePath} to ${targetPath}`);
        } else {
          await smbClient.sendFile(tempFilePath, targetPath);
          console.log(`  Copied to ${targetPath}`);
        }
        continue;
      }

      const tempJsonPath = path.join(os.tmpdir(), jsonFileName);
      await smbClient.getFile(path.join(sourceDir, jsonFileName).replace(/\\/g, "/"), tempJsonPath);
      const jsonContentBuffer = await fs.readFile(tempJsonPath);
      const metadata = JSON.parse(jsonContentBuffer.toString());
      await fs.unlink(tempJsonPath);

      const timestamp = metadata.photoTakenTime?.timestamp || metadata.creationTime?.timestamp;
      if (!timestamp) {
        console.log(`- No timestamp for ${entryName}, skipping.`);
        continue;
      }

      const takenDate = new Date(parseInt(timestamp, 10) * 1000);
      const fileTags = await exiftool.read(tempFilePath);
      const correctExtension = (fileTags.FileTypeExtension || path.extname(entryName).substring(1)).toLowerCase();

      const newBaseName = formatDate(takenDate);
      const isEdited = entryName.toLowerCase().includes("-edited");
      const finalNewBaseName = `${newBaseName}${isEdited ? "-edited" : ""}`;

      let newFileName = `${finalNewBaseName}.${correctExtension}`;
      let counter = 1;
      while (existingTargetFiles.has(newFileName)) {
        newFileName = `${finalNewBaseName}(${counter}).${correctExtension}`;
        counter++;
      }

      if (existingTargetFiles.has(newFileName)) {
        console.log(`- Skipping already processed file: ${newFileName}`);
        continue;
      }

      const newTargetPath = path.join(targetDir, newFileName).replace(/\\/g, "/");
      console.log(`- Processing: ${entryName} -> ${newFileName}`);

      if (IS_DRY_RUN) {
        console.log(`  (Dry Run) Would update EXIF and upload to ${newTargetPath}`);
      } else {
        await exiftool.write(
          tempFilePath,
          { AllDates: formatExifDate(takenDate) },
          ["-m"],
        );
        await smbClient.sendFile(tempFilePath, newTargetPath);
        console.log(`  Processed and moved to ${newTargetPath}`);
        existingTargetFiles.add(newFileName);
      }
    } catch (error) {
      console.error(`- Error processing ${entryName}:`, error);
    } finally {
      try { await fs.unlink(tempFilePath); } catch { }
    }
  }
};

const processGoogleTakeout = async () => {
  console.log("Starting Google Takeout file processing...");
  if (IS_DRY_RUN) {
    console.log("*** Running in DRY RUN mode. No files will be changed. ***");
  }
  console.log(`Source path: //${SERVER_NAME}/${SHARE_NAME}/${REMOTE_SOURCE_PATH}`);
  console.log(`Target path: //${SERVER_NAME}/${SHARE_NAME}/${REMOTE_PROCESSED_PATH}`);

  try {
    await processDirectory(REMOTE_SOURCE_PATH, REMOTE_PROCESSED_PATH);
    console.log("\nProcessing completed successfully!");
  } catch (error) {
    console.error("\nAn unexpected error occurred:", error);
  } finally {
    await exiftool.end();
    console.log("ExifTool process shut down.");
  }
};

processGoogleTakeout();