/**
 * Reorganize Google Takeout files directly on an SMB share using smbclient.
 *
 * This script is designed to work on a remote SMB share that contains multiple
 * Google Takeout extraction folders (e.g., "Takeout 1", "Takeout 2").
 *
 * It performs the following steps entirely on the remote share:
 * 1. Scans a specified source directory for folders named "Takeout*".
 * 2. For each "Takeout" folder, it locates the "Google Photos" subfolder.
 * 3. It then moves the entire contents of each "Google Photos" folder to a
 *    single, consolidated "REMOTE_TARGET_PATH".
 * 4. The script creates the target directory if it doesn't exist.
 *
 * This effectively merges the contents of all "Google Photos" folders into
 * one location on the network drive without any local file transfers.
 */

import path from "path";
import SambaClient from "samba-client";

const IS_DRY_RUN = false;
const SERVER_NAME = "192.168.1.121";
const SHARE_NAME = "Data";
const REMOTE_SOURCE_PATH = "!Pictures/Google Takeout 2025-05-20";
const REMOTE_TARGET_PATH = path
  .join(REMOTE_SOURCE_PATH, "merged")
  .replace(/\\/g, "/");

const smbClient = new SambaClient({
  address: `//${SERVER_NAME}/${SHARE_NAME}`,
  username: process.env.SMB_USERNAME || "guest",
  password: process.env.SMB_PASSWORD || "",
  domain: "WORKGROUP",
});

/**
 * Recursively merges the contents of a source directory into a target directory on the SMB share.
 * It handles nested directories and avoids errors if items already exist in the target.
 * @param sourceDir The full remote path of the directory to merge from.
 * @param targetDir The full remote path of the destination directory.
 */
const mergeDirectoryContents = async (sourceDir: string, targetDir: string) => {
  try {
    const listPath = path.join(sourceDir, "*").replace(/\\/g, "/");
    const dirResult = await smbClient.dir(listPath);
    const allEntries = dirResult.toString().split('\n').filter(line => {
      const trimmed = line.trim();
      // Filter out metadata files and the summary line from smbclient
      return trimmed && !trimmed.includes("blocks of size") && !trimmed.startsWith(".");
    });

    // Ensure the target directory exists before trying to move items into it
    try {
      await smbClient.mkdir(targetDir);
    } catch (e) {
      // Directory likely already exists, which is fine for merging.
    }

    for (const line of allEntries) {
      const parts = line.trim().split(/\s{2,}/);
      const entryName = parts[0];
      const isDirectory = line.includes(" D ");

      const sourcePath = path.join(sourceDir, entryName).replace(/\\/g, "/");
      const targetPath = path.join(targetDir, entryName).replace(/\\/g, "/");

      if (isDirectory) {
        console.log(`- Merging directory: ${sourcePath} -> ${targetPath}`);
        // Recursively merge the subdirectory
        await mergeDirectoryContents(sourcePath, targetPath);
      } else {
        // It's a file, move it.
        if (IS_DRY_RUN) {
          console.log(`  (Dry Run) Would move file: ${sourcePath} -> ${targetPath}`);
        } else {
          try {
            await smbClient.execute("rename", `"${sourcePath}" "${targetPath}"`);
            console.log(`  - Moved file: ${entryName}`);
          } catch (moveError) {
            // This error is expected if the file already exists.
            // This makes the script idempotent.
            console.warn(`  - Could not move '${entryName}', it may already exist in the target. Skipping.`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error processing directory ${sourceDir}:`, error);
  }
};

const reorganizeOnSmb = async () => {
  console.log("Starting reorganization process on SMB share...");
  if (IS_DRY_RUN) {
    console.log("*** Running in DRY RUN mode. No files will be changed. ***");
  }
  console.log(`Source path: //${SERVER_NAME}/${SHARE_NAME}/${REMOTE_SOURCE_PATH}`);
  console.log(`Target path: //${SERVER_NAME}/${SHARE_NAME}/${REMOTE_TARGET_PATH}`);

  try {
    // Ensure the target directory exists
    try {
      await smbClient.mkdir(REMOTE_TARGET_PATH);
      console.log(`Created target directory: ${REMOTE_TARGET_PATH}`);
    } catch (error) {
      // It might fail if it already exists, which is fine.
      console.log(`Target directory ${REMOTE_TARGET_PATH} may already exist.`);
    }

    const listPath = path.join(REMOTE_SOURCE_PATH, "*").replace(/\\/g, "/");
    const allEntriesResult = await smbClient.dir(listPath);
    const allEntriesString = allEntriesResult.toString();
    const allEntries = allEntriesString.split("\n").filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.includes("blocks of size");
    });

    const takeoutFolders = allEntries
      .filter(line => line.includes(" D ")) // "D" indicates a directory
      .map(line => line.split(" D ")[0].trim())
      .filter(name => name.startsWith("Takeout"));

    if (takeoutFolders.length === 0) {
      console.log(`No "Takeout" folders found in ${REMOTE_SOURCE_PATH}.`);
      return;
    }

    console.log(`Found ${takeoutFolders.length} "Takeout" folder(s).`);

    for (const folderName of takeoutFolders) {
      const takeoutPath = path.join(REMOTE_SOURCE_PATH, folderName);
      const googlePhotosPath = path.join(takeoutPath, "Google Photos").replace(/\\/g, "/");

      try {
        await smbClient.dir(googlePhotosPath); // Check if "Google Photos" exists
        console.log(`\nProcessing: ${googlePhotosPath}`);
        await mergeDirectoryContents(googlePhotosPath, REMOTE_TARGET_PATH);
      } catch (error) {
        console.log(`No "Google Photos" folder in ${takeoutPath}, skipping.`);
      }
    }

    console.log("\nReorganization process completed successfully!");
  } catch (error) {
    console.error("\nAn error occurred during the reorganization:", error);
  }
};

reorganizeOnSmb();
