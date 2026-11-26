# PPT 图片局部修改工具

本项目提取自星幕 PPT 的图片框选修改功能，提供本地独立页面。支持拖拽框选、AI 重绘、选区模糊、选区图片覆盖、整图替换、撤销与重做，并可下载修改后的 PNG。

## 启动

需要 Python 3.10 或以上。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export IMAGE_API_BASE="https://your-provider.example/v1"
export IMAGE_API_KEY="your-api-key"
export IMAGE_MODEL="gpt-image-2.6-sunburst"
python app.py
```

浏览器打开 http://127.0.0.1:8788。选择图片，点击“框选修改”，在图片上拖动选区并输入修改要求。AI 修改需要服务商提供兼容 `/images/edits` 的接口。模糊、覆盖和整图替换可在没有 API 配置时使用。

图片、历史版本保存在当前浏览器页面的内存中，刷新后需重新选择图片。调用 AI 时，整张图片、选区蒙版与修改指令会发给配置的服务商。

## 技术说明

- 浏览器将屏幕坐标换算为原始图片像素坐标，服务端生成蒙版和请求。
- AI 模式参照原项目的蒙版路径，向 `/images/edits` 提交原图、蒙版和指令，蒙版采用黑底白选区且完全不透明。服务商蒙版语义必须与此兼容。
- 原线上系统还支持根据服务商能力切换至整图参考回退模式、后台任务、版本存储、账号和计费。此独立版使用同步请求和浏览器内存历史，当前只接入蒙版路径。
- 模糊使用 Pillow 的 BoxBlur，覆盖和整图替换使用居中裁剪缩放。实现遵循原功能思路，具体像素可能与线上 Go 实现有差异。
- `original/` 保存对应线上代码的前端文件与核心 Go 代码片段，来源于香港服务器项目的 `33609c4` 版本。独立版适配代码位于 `app.py` 和 `static/`。

## 文件

- `app.py` 本地接口、图片处理和 AI 请求
- `static/` 独立前端
- `original/` 原始功能代码，供对照和继续提取

请勿将真实密钥写入代码或提交到 Git。默认服务只监听本机。
