import { Texture } from "../texture.js";
import { RenderPassFlags } from "../render_pass.js";
import { MeshTaskQueue } from "../mesh_task_queue.js";
import { TransformFragment } from "../../core/ecs/fragments/transform_fragment.js";
import { LightFragment } from "../../core/ecs/fragments/light_fragment.js";
import {
  SharedViewBuffer,
  SharedEnvironmentMapData,
} from "../../core/shared_data.js";
import { Material } from "../material.js";
import { npot, clamp } from "../../utility/math.js";
import { profile_scope } from "../../utility/performance.js";

export class DeferredShadingStrategy {
  initialized = false;
  hzb_image = null;

  setup(context, render_graph) {
    const image_extent = context.get_canvas_resolution();

    const image_width_npot = npot(image_extent.width);
    const image_height_npot = npot(image_extent.height);

    const mip_levels = Math.max(
      Math.log2(image_width_npot),
      Math.log2(image_height_npot)
    );

    this.hzb_image = Texture.create(context, {
      name: "hzb",
      format: "r32float",
      width: image_width_npot,
      height: image_height_npot,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      mip_levels: mip_levels,
      b_one_view_per_mip: true,
    });
  }

  draw(context, render_graph) {
    profile_scope("DeferredShadingStrategy.draw", () => {
      if (!this.initialized) {
        this.setup(context, render_graph);
        this.initialized = true;
      }

      MeshTaskQueue.get().sort_and_batch(context);

      const transform_gpu_data = TransformFragment.to_gpu_data(context);
      const entity_transforms = render_graph.register_buffer(
        transform_gpu_data.gpu_buffer.config.name
      );

      const light_gpu_data = LightFragment.to_gpu_data(context);
      const lights = render_graph.register_buffer(
        light_gpu_data.gpu_buffer.config.name
      );

      const object_instance_buffer =
        MeshTaskQueue.get().get_object_instance_buffer();
      const object_instances = render_graph.register_buffer(
        object_instance_buffer.config.name
      );

      const compacted_object_instance_buffer = render_graph.create_buffer({
        name: "compacted_object_instance_buffer",
        raw_data: new Uint32Array(MeshTaskQueue.get().get_total_draw_count()),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const indirect_draw_buffer =
        MeshTaskQueue.get().get_indirect_draw_buffer();
      const indirect_draws = render_graph.register_buffer(
        indirect_draw_buffer.config.name
      );

      let skybox_image = null;
      let main_hzb_image = null;
      let main_albedo_image = null;
      let main_depth_image = null;
      let main_smra_image = null;
      let main_cc_image = null;
      let main_normal_image = null;
      let main_position_image = null;
      let main_entity_id_image = null;
      let post_lighting_image_desc = null;
      let post_bloom_color_desc = null;

      const image_extent = context.get_canvas_resolution();

      // Skybox Pass
      {
        const shader_setup = {
          pipeline_shaders: {
            vertex: {
              path: "skybox.wgsl",
            },
            fragment: {
              path: "skybox.wgsl",
            },
          },
          rasterizer_state: {
            cull_mode: "none",
          },
          depth_write_enabled: false,
        };

        const skybox = SharedEnvironmentMapData.get().get_skybox();
        const skybox_texture = render_graph.register_image(skybox.config.name);

        skybox_image = render_graph.create_image({
          name: "skybox_output",
          format: "bgra8unorm",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        render_graph.add_pass(
          "skybox_pass",
          RenderPassFlags.Graphics,
          {
            inputs: [skybox_texture],
            outputs: [skybox_image],
            shader_setup,
          },
          (graph, frame_data, encoder) => {
            const pass = graph.get_physical_pass(frame_data.current_pass);
            MeshTaskQueue.get().draw_cube(frame_data.context, pass);
          }
        );
      }

      // Mesh cull pass
      {
        // Compute cull pass
        const shader_setup = {
          pipeline_shaders: {
            compute: {
              path: "cull.wgsl",
            },
          },
        };

        // Needs to be persistent, so not initialized with the transient flag
        main_hzb_image = render_graph.register_image(
          this.hzb_image.config.name
        );

        const draw_cull_data = render_graph.create_buffer({
          name: `draw_cull_data`,
          data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        render_graph.add_pass(
          "compute_cull",
          RenderPassFlags.Compute,
          {
            shader_setup,
            inputs: [
              main_hzb_image,
              entity_transforms,
              object_instances,
              compacted_object_instance_buffer,
              indirect_draws,
              draw_cull_data,
            ],
            outputs: [indirect_draws],
          },
          (graph, frame_data, encoder) => {
            const pass = graph.get_physical_pass(frame_data.current_pass);

            const hzb = graph.get_physical_image(main_hzb_image);
            const draw_cull = graph.get_physical_buffer(draw_cull_data);
            const draw_count = MeshTaskQueue.get().get_total_draw_count();
            const view_data = SharedViewBuffer.get().get_view_data(0);

            draw_cull.write(frame_data.context, [
              draw_count,
              1 /* culling_enabled */,
              1 /* occlusion_enabled */,
              1 /* distance_check */,
              view_data.near,
              view_data.far,
              view_data.projection_matrix[0],
              view_data.projection_matrix[5],
              hzb.config.width,
              hzb.config.height,
            ]);

            pass.dispatch((draw_count + 255) / 256, 1, 1);
          }
        );
      }

      // GBuffer Base Pass
      {
        const shader_setup = {
          pipeline_shaders: {
            vertex: {
              path: "gbuffer_base.wgsl",
            },
            fragment: {
              path: "gbuffer_base.wgsl",
            },
          },
        };

        main_albedo_image = render_graph.create_image({
          name: "main_albedo",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        main_smra_image = render_graph.create_image({
          name: "main_smra",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        main_normal_image = render_graph.create_image({
          name: "main_normal",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        main_position_image = render_graph.create_image({
          name: "main_position",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        main_entity_id_image = render_graph.create_image({
          name: "main_entity_id",
          format: "r32uint",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        main_depth_image = render_graph.create_image({
          name: "main_depth",
          format: "depth32float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          load_op: "load",
        });

        const material_buckets = MeshTaskQueue.get().get_material_buckets();
        for (const material_id of material_buckets) {
          const material = Material.get(material_id);

          render_graph.add_pass(
            `g_buffer_${material.template.name}_${material_id}`,
            RenderPassFlags.Graphics,
            {
              inputs: [
                entity_transforms,
                compacted_object_instance_buffer,
              ],
              outputs: [
                main_albedo_image,
                main_smra_image,
                main_position_image,
                main_normal_image,
                main_entity_id_image,
                main_depth_image,
              ],
              shader_setup,
              b_skip_pass_pipeline_setup: true
            },
            (graph, frame_data, encoder) => {
              const pass = graph.get_physical_pass(frame_data.current_pass);

              if (!frame_data.g_buffer_data) {
                frame_data.g_buffer_data = {
                  albedo: graph.get_physical_image(main_albedo_image),
                  smra: graph.get_physical_image(main_smra_image),
                  position: graph.get_physical_image(main_position_image),
                  normal: graph.get_physical_image(main_normal_image),
                  entity_id: graph.get_physical_image(main_entity_id_image),
                  depth: graph.get_physical_image(main_depth_image),
                };

                frame_data.g_buffer_data.albedo.config.load_op = "load";
                frame_data.g_buffer_data.smra.config.load_op = "load";
                frame_data.g_buffer_data.position.config.load_op = "load";
                frame_data.g_buffer_data.normal.config.load_op = "load";
                frame_data.g_buffer_data.entity_id.config.load_op = "load";
              }

              MeshTaskQueue.get().submit_material_indexed_indirect_draws(
                pass,
                frame_data,
                material_id,
                false /* should_reset */
              );
            }
          );
        }
      }

      // Reset GBuffer targets
      {
        render_graph.add_pass(
          "reset_g_buffer_targets",
          RenderPassFlags.GraphLocal,
          {},
          (graph, frame_data, encoder) => {
            frame_data.g_buffer_data.albedo.config.load_op = "clear";
            frame_data.g_buffer_data.smra.config.load_op = "clear";
            frame_data.g_buffer_data.position.config.load_op = "clear";
            frame_data.g_buffer_data.normal.config.load_op = "clear";
            frame_data.g_buffer_data.entity_id.config.load_op = "clear";
            frame_data.g_buffer_data.depth.config.load_op = "clear";
          }
        );
      }

      // HZB generation pass
      {
        const shader_setup = {
          pipeline_shaders: {
            compute: {
              path: "hzb_reduce.wgsl",
            },
          },
        };

        let hzb_params_chain = [];
        for (let i = 0; i < this.hzb_image.config.mip_levels; i++) {
          hzb_params_chain.push(
            render_graph.create_buffer({
              name: `hzb_params_${i}`,
              data: [0.0, 0.0, 0.0, 0.0],
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
          );
        }

        for (let i = 0; i < this.hzb_image.config.mip_levels; i++) {
          const src_index = i === 0 ? 0 : i - 1;
          const dst_index = i;

          render_graph.add_pass(
            `reduce_hzb_${i}`,
            RenderPassFlags.Compute,
            {
              inputs: [
                i === 0 ? main_depth_image : main_hzb_image,
                main_hzb_image,
                hzb_params_chain[dst_index],
              ],
              outputs: [main_hzb_image],
              input_views: [src_index, dst_index],
              shader_setup: shader_setup,
            },
            (graph, frame_data, encoder) => {
              const pass = graph.get_physical_pass(frame_data.current_pass);

              const depth = graph.get_physical_image(main_depth_image);
              const hzb = graph.get_physical_image(main_hzb_image);

              const hzb_params = graph.get_physical_buffer(
                hzb_params_chain[dst_index]
              );

              const src_mip_width = Math.max(1, i === 0 ? depth.config.width : hzb.config.width >> src_index);
              const src_mip_height = Math.max(
                1,
                i === 0 ? depth.config.height : hzb.config.height >> src_index
              );

              const dst_mip_width = Math.max(1, hzb.config.width >> dst_index);
              const dst_mip_height = Math.max(
                1,
                hzb.config.height >> dst_index
              );

              hzb_params.write(frame_data.context, [
                src_mip_width,
                src_mip_height,
                dst_mip_width,
                dst_mip_height,
              ]);

              pass.dispatch(
                (dst_mip_width + 15) / 16,
                (dst_mip_height + 15) / 16,
                1
              );
            }
          );
        }
      }

      // Lighting Pass
      {
        const shader_setup = {
          pipeline_shaders: {
            vertex: {
              path: "deferred_lighting.wgsl",
            },
            fragment: {
              path: "deferred_lighting.wgsl",
            },
          },
        };

        post_lighting_image_desc = render_graph.create_image({
          name: "post_lighting",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        render_graph.add_pass(
          "lighting_pass",
          RenderPassFlags.Graphics,
          {
            inputs: [
              skybox_image,
              main_albedo_image,
              main_smra_image,
              main_normal_image,
              main_position_image,
              main_depth_image,
              lights,
            ],
            outputs: [post_lighting_image_desc],
            shader_setup,
          },
          (graph, frame_data, encoder) => {
            const pass = graph.get_physical_pass(frame_data.current_pass);
            MeshTaskQueue.get().draw_quad(frame_data.context, pass);
          }
        );
      }

      // Bloom pass
      const num_iterations = 4;
      if (num_iterations > 0) {
        const image_extent = context.get_canvas_resolution();
        const extent_x = npot(image_extent.width);
        const extent_y = npot(image_extent.height);

        let bloom_blur_chain = [];
        let bloom_blur_params_chain = [];
        for (let i = 0; i < num_iterations; i++) {
          bloom_blur_chain.push(
            render_graph.create_image({
              name: `bloom_blur_${i}`,
              format: "rgba16float",
              width: extent_x >> i,
              height: extent_y >> i,
              usage:
                GPUTextureUsage.STORAGE_BINDING |
                GPUTextureUsage.TEXTURE_BINDING,
            })
          );
          bloom_blur_params_chain.push(
            render_graph.create_buffer({
              name: `bloom_blur_params_${i}`,
              data: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
          );
        }

        const bloom_downsample_shader_setup = {
          pipeline_shaders: {
            compute: {
              path: "effects/bloom_downsample.wgsl",
            },
          },
        };

        for (let i = 0; i < num_iterations; i++) {
          const src_index = i === 0 ? 0 : i - 1;
          const dst_index = i;

          render_graph.add_pass(
            `bloom_downsample_pass_${i}`,
            RenderPassFlags.Compute,
            {
              inputs: [
                i === 0
                  ? post_lighting_image_desc
                  : bloom_blur_chain[src_index],
                bloom_blur_chain[dst_index],
                bloom_blur_params_chain[dst_index],
              ],
              outputs: [bloom_blur_chain[dst_index]],
              shader_setup: bloom_downsample_shader_setup,
            },
            (graph, frame_data, encoder) => {
              const pass = graph.get_physical_pass(frame_data.current_pass);

              const bloom_blur_params = graph.get_physical_buffer(
                bloom_blur_params_chain[dst_index]
              );

              const src_mip_width = clamp(extent_x >> src_index, 1, extent_x);
              const src_mip_height = clamp(extent_y >> src_index, 1, extent_y);

              const dst_mip_width = clamp(extent_x >> dst_index, 1, extent_x);
              const dst_mip_height = clamp(extent_y >> dst_index, 1, extent_y);

              bloom_blur_params.write(frame_data.context, [
                src_mip_width,
                src_mip_height,
                dst_mip_width,
                dst_mip_height,
                0.0,
                i,
              ]);

              pass.dispatch(
                (dst_mip_width + 15) / 16,
                (dst_mip_height + 15) / 16,
                1
              );
            }
          );
        }

        const bloom_upsample_shader_setup = {
          pipeline_shaders: {
            compute: {
              path: "effects/bloom_upsample.wgsl",
            },
          },
        };

        for (let i = num_iterations - 1; i > 0; --i) {
          const src_index = i;
          const dst_index = i - 1;

          render_graph.add_pass(
            `bloom_upsample_pass_${i}`,
            RenderPassFlags.Compute,
            {
              inputs: [
                bloom_blur_chain[src_index],
                bloom_blur_chain[dst_index],
                bloom_blur_params_chain[dst_index],
              ],
              outputs: [bloom_blur_chain[dst_index]],
              shader_setup: bloom_upsample_shader_setup,
            },
            (graph, frame_data, encoder) => {
              const pass = graph.get_physical_pass(frame_data.current_pass);

              const bloom_blur_params = graph.get_physical_buffer(
                bloom_blur_params_chain[dst_index]
              );

              const src_mip_width = clamp(extent_x >> src_index, 1, extent_x);
              const src_mip_height = clamp(extent_y >> src_index, 1, extent_y);

              const dst_mip_width = clamp(extent_x >> dst_index, 1, extent_x);
              const dst_mip_height = clamp(extent_y >> dst_index, 1, extent_y);

              bloom_blur_params.write(frame_data.context, [
                src_mip_width,
                src_mip_height,
                dst_mip_width,
                dst_mip_height,
                0.005,
                i,
              ]);

              pass.dispatch(
                (dst_mip_width + 15) / 16,
                (dst_mip_height + 15) / 16,
                1
              );
            }
          );
        }

        const bloom_resolve_shader_setup = {
          pipeline_shaders: {
            vertex: {
              path: "fullscreen.wgsl",
            },
            fragment: {
              path: "effects/bloom_resolve.wgsl",
            },
          },
        };

        let bloom_resolve_params_desc = render_graph.create_buffer({
          name: "bloom_resolve_params",
          data: [0.0, 0.0, 0.0, 0.0],
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        post_bloom_color_desc = render_graph.create_image({
          name: "post_bloom_color",
          format: "rgba16float",
          width: image_extent.width,
          height: image_extent.height,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        render_graph.add_pass(
          "bloom_resolve_pass",
          RenderPassFlags.Graphics,
          {
            inputs: [
              post_lighting_image_desc,
              bloom_blur_chain[0],
              bloom_resolve_params_desc,
            ],
            outputs: [post_bloom_color_desc],
            shader_setup: bloom_resolve_shader_setup,
          },
          (graph, frame_data, encoder) => {
            const pass = graph.get_physical_pass(frame_data.current_pass);

            const bloom_resolve_params = graph.get_physical_buffer(
              bloom_resolve_params_desc
            );

            bloom_resolve_params.write(
              frame_data.context,
              [
                1.5 /* final exposure */, 0.3 /* bloom intensity */,
                0.001 /* bloom threshold */, 0.0 /* bloom knee */,
              ]
            );

            MeshTaskQueue.get().draw_quad(frame_data.context, pass);
          }
        );
      }

      const antialiased_scene_color_desc = post_bloom_color_desc;

      // Fullscreen Present Pass
      {
        const swapchain_image = Texture.create_from_texture(
          context.context.getCurrentTexture(),
          "swapchain"
        );

        const rg_output_image = render_graph.register_image(
          swapchain_image.config.name
        );

        const shader_setup = {
          pipeline_shaders: {
            vertex: {
              path: "fullscreen.wgsl",
            },
            fragment: {
              path: "fullscreen.wgsl",
            },
          },
        };

        render_graph.add_pass(
          "fullscreen_present_pass",
          RenderPassFlags.Graphics | RenderPassFlags.Present,
          {
            inputs: [antialiased_scene_color_desc],
            outputs: [rg_output_image],
            shader_setup,
          },
          (graph, frame_data, encoder) => {
            const pass = graph.get_physical_pass(frame_data.current_pass);
            MeshTaskQueue.get().draw_quad(frame_data.context, pass);
          }
        );
      }

      render_graph.submit(context);
    });
  }
}
