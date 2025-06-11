#!/bin/bash

# exiftool -time:all -a -G1 -s image.jpg - check tags

# Check if exiftool is installed
if ! command -v exiftool &> /dev/null
then
    echo "Error: exiftool is not installed. Please install it to continue."
    echo "On macOS, you can use Homebrew: brew install exiftool"
    exit 1
fi

# Validate arguments
if ! [[ "$1" =~ ^[0-9]{4}$ ]]; then
  echo "Error: Invalid or missing year. Please provide a 4-digit year."
  echo "Usage: $0 <year>"
  exit 1
fi

YEAR=$1
EXTENSIONS=("jpg" "jpeg" "png" "gif" "mov" "mp4")

# Set fallback date from argument (YYYY:MM:DD HH:MM:SS)
FALLBACK_DATE="$YEAR:01:01 00:00:00"

for EXTENSION in "${EXTENSIONS[@]}"; do
  echo "Processing files with extension: $EXTENSION"
  # Loop through all files with the given extension recursively
  find . -type f -iname "*.$EXTENSION" | while read -r file; do
    echo "Processing: $file"

    # Extract DateTimeOriginal
    exif_date=$(exiftool -s3 -DateTimeOriginal "$file")

    if [[ -n "$exif_date" ]]; then
      modify_date=$(exiftool -s3 -d "%Y:%m:%d %H:%M:%S" -FileModifyDate "$file")
      if [[ "$exif_date" == "$modify_date" ]]; then
        echo "→ FileModifyDate already matches DateTimeOriginal. Skipping."
      else
        echo "→ DateTimeOriginal found. Updating FileModifyDate."
        exiftool -overwrite_original "-FileModifyDate<DateTimeOriginal" "$file"
      fi
    else
      echo "→ DateTimeOriginal not found. Setting to fallback and updating FileModifyDate."
      exiftool -overwrite_original "-DateTimeOriginal=$FALLBACK_DATE" "-FileModifyDate<DateTimeOriginal" "$file"
    fi
  done
done