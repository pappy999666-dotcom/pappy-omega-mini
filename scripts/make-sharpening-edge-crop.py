from pathlib import Path
from PIL import Image, ImageDraw

root = Path('/home/ubuntu/pappy-omega-mini/artifacts/sharpening-benchmark')
items = [
    ('source', root / 'source.jpg'),
    ('current', root / 'group-current.jpg'),
    ('stronger', root / 'group-stronger-profile.jpg'),
    ('aggressive', root / 'group-aggressive-profile.jpg'),
]
# Focus on hair/face boundary and bright cheek against dark background.
boxes = [(130, 0, 443, 250), (0, 80, 443, 360)]
for box_index, box in enumerate(boxes, 1):
    crops = []
    for label, path in items:
        image = Image.open(path).convert('RGB').crop(box)
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.NEAREST)
        crops.append((label, image))
    width = sum(image.width for _, image in crops)
    height = max(image.height for _, image in crops) + 34
    sheet = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(sheet)
    x = 0
    for label, image in crops:
        draw.text((x + 8, 8), label, fill='black')
        sheet.paste(image, (x, 34))
        x += image.width
    output = root / f'sharpening-edge-crop-{box_index}.jpg'
    sheet.save(output, quality=95, subsampling=0)
    print(output)
