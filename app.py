import base64
import io
import json
import os

import requests
from flask import Flask, jsonify, request, send_from_directory
from PIL import Image, ImageDraw, ImageFilter, ImageOps

app = Flask(__name__, static_folder='static')
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def png_bytes(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def read_image(file):
    image = Image.open(file.stream)
    image.load()
    return ImageOps.exif_transpose(image).convert('RGBA')


def selection_box(raw, image):
    selection = json.loads(raw)
    iw = float(selection.get('imageWidth') or image.width)
    ih = float(selection.get('imageHeight') or image.height)
    if iw <= 0 or ih <= 0:
        raise ValueError('图片尺寸无效')
    x = max(0, min(image.width - 1, round(float(selection['x']) * image.width / iw)))
    y = max(0, min(image.height - 1, round(float(selection['y']) * image.height / ih)))
    w = min(image.width - x, max(1, round(float(selection['width']) * image.width / iw)))
    h = min(image.height - y, max(1, round(float(selection['height']) * image.height / ih)))
    return (x, y, x + w, y + h)


def ai_edit(image, box, instruction, mode=None):
    base = os.getenv('IMAGE_API_BASE', '').rstrip('/')
    key = os.getenv('IMAGE_API_KEY', '')
    model = os.getenv('IMAGE_MODEL', 'gpt-image-2.6-sunburst')
    if not base or not key:
        raise ValueError('请先在启动环境中设置 IMAGE_API_BASE 和 IMAGE_API_KEY')
    mode = (mode or os.getenv('IMAGE_EDIT_MODE', 'mask')).lower()
    fields = {'model': model, 'prompt': instruction, 'response_format': 'b64_json'}
    if mode == 'mask':
        mask = Image.new('RGBA', image.size, (0, 0, 0, 255))
        ImageDraw.Draw(mask).rectangle((box[0], box[1], box[2]-1, box[3]-1), fill=(255, 255, 255, 255))
        files = {'image': ('base.png', png_bytes(image), 'image/png'),
                 'mask': ('mask.png', png_bytes(mask), 'image/png')}
    elif mode == 'reference':
        x, y, right, bottom = box
        fields['prompt'] = (f'仅修改图片中位于坐标 (x={x}, y={y}, width={right-x}, '
                            f'height={bottom-y}) 的区域：{instruction}。其余区域必须与原图保持完全一致，'
                            '不要改变整体版式、字体风格与配色。')
        files = {'image[]': ('ref_0.png', png_bytes(image), 'image/png')}
    else:
        raise ValueError('IMAGE_EDIT_MODE 应为 mask 或 reference')
    response = requests.post(base + '/images/edits', headers={'Authorization': 'Bearer ' + key},
                             data=fields, files=files, timeout=600)
    if not response.ok:
        raise ValueError(f'图片服务返回 HTTP {response.status_code}')
    item = response.json()['data'][0]
    if item.get('b64_json'):
        raw = base64.b64decode(item['b64_json'])
    elif item.get('url'):
        result = requests.get(item['url'], timeout=120)
        result.raise_for_status()
        raw = result.content
    else:
        raise ValueError('图片服务没有返回图片')
    result = Image.open(io.BytesIO(raw))
    result.load()
    result = result.convert('RGBA')
    if result.size != image.size:
        original_ratio = image.width / image.height
        result_ratio = result.width / result.height
        if abs(result_ratio / original_ratio - 1) > 0.01:
            raise ValueError('图片服务返回的宽高比例与原图不一致，无法准确定位选区，请重试或更换模型')
        result = result.resize(image.size, Image.Resampling.LANCZOS)
    # Keep the original pixels outside the selected rectangle.
    output = image.copy()
    output.paste(result.crop(box), box)
    return output


@app.get('/')
def index():
    return send_from_directory('static', 'index.html')


@app.post('/api/edit')
def edit():
    try:
        image = read_image(request.files['image'])
        operation = request.form['operation']
        if operation == 'replace_full':
            result = ImageOps.fit(read_image(request.files['patch']), image.size, method=Image.Resampling.LANCZOS)
        else:
            box = selection_box(request.form['selection'], image)
            if operation == 'erase_region':
                result = image.copy()
                result.paste(image.crop(box).filter(ImageFilter.BoxBlur(24)), box)
            elif operation == 'region_overlay':
                patch = ImageOps.fit(read_image(request.files['patch']), (box[2]-box[0], box[3]-box[1]), method=Image.Resampling.LANCZOS)
                result = image.copy()
                result.alpha_composite(patch, (box[0], box[1]))
            elif operation == 'ai_region_edit':
                instruction = request.form.get('instruction', '').strip()
                if not instruction:
                    raise ValueError('请输入修改要求')
                result = ai_edit(image, box, instruction, request.form.get('mode'))
            else:
                raise ValueError('不支持的操作')
        return app.response_class(png_bytes(result), mimetype='image/png')
    except (KeyError, ValueError, OSError, requests.RequestException) as exc:
        return jsonify(error=str(exc)), 400


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.getenv('PORT', '8788')), threaded=True)
