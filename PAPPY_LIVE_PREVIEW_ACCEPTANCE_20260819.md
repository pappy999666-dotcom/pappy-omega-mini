# Live Preview Acceptance Test — 2026-08-19

Test session: `4efde35b-d609-4cf1-879d-4d9dd0cc1eda`.

Owner test group: `120363411025087513@g.us`.

Test URL: `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN`.

## Source stage

The cache-v3 record resolved the WhatsApp invite image from `pps.whatsapp.net` with HTTP 200, content type `image/jpeg`, source dimensions `443 x 720`, and source size `33,447` bytes.

## Sharp stage

The processed record is JPEG, `443 x 720`, and `61,871` bytes. The current group normalization uses `fit: inside`, `withoutEnlargement: true`, Lanczos3, mild sharpening, 4:4:4 chroma, and bounded quality attempts. The dimensions prove that this source was not upscaled or cropped.

## Native payload stage

The normal chat payload contains `linkPreview` with canonical URL, matched text, title, description, and a `jpegThumbnail` of `61,871` bytes.

The group-status payload contains `groupStatus: true`, `richPreview: true`, canonical URL text, `previewTitle: Gc closed`, `previewDescription: WhatsApp Group Invite`, and a `previewImage` buffer of `61,871` bytes at `443 x 720` JPEG.

## Live transport correlation

At `12:07:13`, the paired session received `.gstatus https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN` in the owner test group. At `12:07:14`, the resulting URL candidate was received. There was no send or preview error in the test window. Pappy remained online with unstable restarts `0`.

## Conclusion

The Pappy byte path did not enlarge or crop this image. The source itself is only `443 x 720`; Sharp preserved those dimensions and the native status payload carried the resulting bytes. Any remaining visual blur for this specific URL originates from the upstream WhatsApp image asset or WhatsApp client rendering, not from an accidental Pappy upscale. A final client screenshot is still required to isolate WhatsApp renderer behavior from the source asset.
