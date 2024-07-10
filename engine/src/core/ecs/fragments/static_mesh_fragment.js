import { Fragment } from '../fragment.js';

export class StaticMeshFragment extends Fragment {
    static material_slot_stride = 64;

    static initialize() {
        this.data = {
            mesh: new BigInt64Array(1),
            material_slots: new Uint32Array(this.material_slot_stride)
        };
    }

    static resize() {
        const resize_array = (obj, key, stride) => {
            if (obj[key].length < this.size * stride) {
                const prev = obj[key];
                obj[key] = new Uint32Array(this.size * stride);
                obj[key].set(prev);
            }
        };

        ['mesh'].forEach(prop => {
            resize_array(this.data, prop, 1);
        });

        ['material_slots'].forEach(prop => {
            resize_array(this.data, prop, this.material_slot_stride);
        });
    }
}