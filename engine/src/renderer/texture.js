import { Name } from "../utility/names.js";
import { ResourceCache, CacheTypes } from "./resource_cache.js";

/**
 * Flags for image resources in the render graph.
 * @enum {number}
 */
export const ImageFlags = Object.freeze({
  /** No flags */
  None: 0,
  /** Indicates a transient image resource */
  Transient: 1,
  /** Indicates the image is loaded locally */
  LocalLoad: 2,
});

/**
 * Configuration for a image resource.
 * @property {string} name - Name of the image.
 * @property {number} width - Width of the image.
 * @property {number} height - Height of the image.
 * @property {number} depth - Depth of the image (for 3D textures) or number of layers (for array textures).
 * @property {number} mip_levels - Number of mip levels in the image.
 * @property {string} format - Format of the image (e.g., "rgba8unorm").
 * @property {number} usage - Usage flags for the image (e.g., GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.SAMPLED).
 * @property {number} sample_count - Number of samples for multisampling.
 * @property {boolean} b_is_bindless - Whether the image is bindless.
 * @property {number} flags - Additional flags for the image (see ImageFlags enum).
 * @property {Object} clear_value - Clear value for the image (e.g., { r: 0, g: 0, b: 0, a: 1 }).
 * @property {string} store_op - Store operation for the image (e.g., "store" or "discard").
 * @property {string} load_op - Load operation for the image (e.g., "load" or "clear").
 */
class TextureConfig {
  name = null;
  width = 0;
  height = 0;
  depth = 0;
  mip_levels = 1;
  format = "rgba8unorm";
  usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.SAMPLED;
  sample_count = 1;
  dimension = "2d";
  b_is_bindless = false;
  flags = ImageFlags.None;
  clear_value = { r: 0, g: 0, b: 0, a: 1 };
  load_op = "clear";
  store_op = "store";
}

export class Texture {
  config = new TextureConfig();
  image = null;
  view = null;

  // Create a GPU buffer to store the data
  init(context, config) {
    this.config = { ...this.config, ...config };
    this.config.type = config.format.includes("depth") ? "depth" : "color";

    if (this.config.type === "depth") {
      this.config.clear_value = 1.0;
      this.config.load_op = "clear";
    }

    this.image = context.device.createTexture({
      label: config.name,
      size: {
        width: config.width,
        height: config.height,
        depthOrArrayLayers: config.depth,
      },
      mipLevelCount: config.mip_levels,
      sampleCount: config.sample_count,
      dimension: config.dimension,
      format: config.format,
      usage: config.usage,
      loadOp: config.load_op ?? "clear",
      storeOp: config.store_op ?? "store",
      clearValue: config.clear_value ?? { r: 0, g: 0, b: 0, a: 1 },
    });

    this.view = this.create_view();
  }

  async load(context, paths, config) {
    this.config = { ...this.config, ...config };
    this.config.type = config.format.includes("depth") ? "depth" : "color";

    if (this.config.type === "depth") {
      this.config.clear_value = 1.0;
      this.config.load_op = "clear";
    }

    async function load_image_bitmap(path) {
      const resolved_img = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = path;
      });

      return await createImageBitmap(resolved_img, {
        colorSpaceConversion: "none",
      });
    }

    const textures = await Promise.all(paths.map(load_image_bitmap));

    this.config.width = textures[0].width;
    this.config.height = textures[0].height;
    this.config.depth = textures.length;

    this.image = context.device.createTexture({
      label: this.config.name,
      size: {
        width: this.config.width,
        height: this.config.height,
        depthOrArrayLayers: this.config.depth,
      },
      mipLevelCount: config.mip_levels,
      sampleCount: config.sample_count,
      format: config.format,
      usage: config.usage,
      loadOp: config.load_op ?? "clear",
      storeOp: config.store_op ?? "store",
      clearValue: config.clear_value ?? { r: 0, g: 0, b: 0, a: 1 },
    });

    textures.forEach((texture, layer) => {
      context.device.queue.copyExternalImageToTexture(
        { source: texture, flipY: true },
        { texture: this.image, origin: { x: 0, y: 0, z: layer } },
        [texture.width, texture.height]
      );
    });

    this.view = this.create_view();
  }

  set_image(image) {
    this.image = image;
    this.config.width = image.width;
    this.config.height = image.height;
    this.config.depth = image.depthOrArrayLayers;
    this.config.mip_levels = image.mipLevelCount;
    this.config.sample_count = image.sampleCount;
    this.config.usage = image.usage;
    this.config.format = image.format;
    this.config.dimension = image.dimension;
    this.config.type = this.config.format.includes("depth") ? "depth" : "color";

    if (this.config.type === "depth") {
      this.config.clear_value = 1.0;
      this.config.load_op = "clear";
    } else {
      this.config.clear_value = { r: 0, g: 0, b: 0, a: 1 };
      this.config.load_op = "clear";
    }

    this.view = this.create_view();
  }

  create_view(view_config = {}) {
    return this.image.createView({
      label: this.config.name,
      dimension: this.config.dimension,
      format: this.config.format,
      aspect: view_config.aspect ?? "all",
      baseMipLevel: view_config.baseMipLevel ?? 0,
      mipLevelCount: view_config.mipLevelCount ?? this.config.mip_levels,
      baseArrayLayer: view_config.baseArrayLayer ?? 0,
      arrayLayerCount: view_config.arrayLayerCount ?? this.config.depth,
    });
  }

  copy_buffer(encoder, buffer) {
    encoder.copyBufferToImage(
      { buffer: buffer.buffer },
      { texture: this.image },
      {
        width: this.config.width,
        height: this.config.height,
        depthOrArrayLayers: 1,
      }
    );
  }

  copy_texture(encoder, texture) {
    encoder.copyTextureToTexture(
      { texture: texture.image },
      { texture: this.image },
      {
        width: this.config.width,
        height: this.config.height,
        depthOrArrayLayers: 1,
      }
    );
  }

  get physical_id() {
    return Name.from(this.config.name);
  }

  static get_default_sampler(context) {
    let sampler = ResourceCache.get().fetch(
      CacheTypes.SAMPLER,
      Name.from("default_sampler")
    );
    if (sampler) {
      return sampler;
    }

    sampler = context.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });

    ResourceCache.get().store(
      CacheTypes.SAMPLER,
      Name.from("default_sampler"),
      sampler
    );

    return sampler;
  }

  static create(context, config) {
    let image = ResourceCache.get().fetch(
      CacheTypes.IMAGE,
      Name.from(config.name)
    );

    if (image) {
      return image;
    }

    image = new Texture();

    image.init(context, config);

    ResourceCache.get().store(CacheTypes.IMAGE, Name.from(config.name), image);

    return image;
  }

  static create_from_texture(raw_image, name) {
    let cached_image = ResourceCache.get().fetch(
      CacheTypes.IMAGE,
      Name.from(name)
    );

    if (cached_image) {
      cached_image.set_image(raw_image);
      return cached_image;
    }

    cached_image = new Texture();

    cached_image.config = { name: name };

    ResourceCache.get().store(CacheTypes.IMAGE, Name.from(name), cached_image);

    cached_image.set_image(raw_image);

    return cached_image;
  }

  static async load(context, paths, config) {
    let image = ResourceCache.get().fetch(
      CacheTypes.IMAGE,
      Name.from(config.name)
    );

    if (image) {
      return image;
    }

    image = new Texture();
    await image.load(context, paths, config);

    ResourceCache.get().store(CacheTypes.IMAGE, Name.from(config.name), image);

    return image;
  }
}