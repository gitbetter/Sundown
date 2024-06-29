const MAX_BUFFERED_FRAMES = 2;

export class GraphicsContext {
    canvas = null;
    adapter = null;
    device = null;
    context = null;
    canvas_format = null;
    frame_number = 0;

    async init(canvas) {
        if (!navigator.gpu) {
            throw Error('WebGPU is not supported');
        }

        this.canvas = canvas;
        this.adapter = await navigator.gpu.requestAdapter();
        if (!this.adapter) {
            throw Error('Unable to request WebGPU adapter');
        }
        
        this.device = await this.adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        this.canvas_format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.canvas_format,
            alphaMode: 'premultiplied'
        });
    }

    advance_frame() {
        this.frame_number++;
    }

    get_frame_number() {
        return this.frame_number;
    }

    get_buffered_frame_number() {
        return this.frame_number % MAX_BUFFERED_FRAMES;
    }

    draw_pass(render_pass, triangles, instance_count = 1) {
        render_pass.pass.draw(triangles, instance_count);
    }

    max_bind_groups() {
        return this.adapter.limits.maxBindGroups;
    }

    static async create(canvas) {
        let context = new GraphicsContext();
        await context.init(canvas);
        return context
    }
}
