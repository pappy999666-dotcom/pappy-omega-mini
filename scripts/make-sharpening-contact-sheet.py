from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path('/home/ubuntu/pappy-omega-mini/artifacts/sharpening-benchmark')
items = [
    ('source', root / 'source.jpg'),
    ('current', root / 'group-current.jpg'),
    ('injected default', root / 'group-injected-default.jpg'),
    ('stronger', root / 'group-stronger-profile.jpg'),
    ('aggressive', root / 'group-aggressive-profile.jpg'),
]
thumb_w, thumb_h = 443, 720
label_h = 48
sheet = Image.new('RGB', (thumb_w * 5, thumb_h + label_h), 'white')
draw = ImageDraw.Draw(sheet)
for i, (label, path) in enumerate(items):
    image = Image.open(path).convert('RGB')
    image.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
    x = i * thumb_w + (thumb_w - image.width) // 2
    y = label_h + (thumb_h - image.height) // 2
    sheet.paste(image, (x, y))
    draw.text((i * thumb_w + 8, 14), label, fill='black')
sheet.save(root / 'sharpening-contact-sheet.jpg', quality=95, subsampling=0)
print(root / 'sharpening-contact-sheet.jpg')
