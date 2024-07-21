export class Fragment {
    static data = null;
    static size = 0;
    static entity_set = new Set();

    static initialize() { }

    static resize(new_size) {
        this.size = new_size;
    }

    static to_gpu_data() { }

    static add_entity(entity, data) {
        this.entity_set.add(entity);
        if (this.entity_set.size >= this.size) {
            this.resize(this.entity_set.size * 2);
        }
        if (data) {
            this.update_entity_data(entity, data);
        }
    }

    static remove_entity(entity) {
        this.entity_set.delete(entity);
        if (entity === this.size - 1) {
            this.resize(Math.max(...this.entity_set) * 2);
        }
    }

    static update_entity_data(entity, data) {
        const update_nested_data = (target_data, source_data, entity_index) => {
            for (const [key, value] of Object.entries(source_data)) {
                if (target_data[key] === undefined) {
                    throw new Error(`Invalid property ${key} for fragment ${this.constructor.name}`);
                }
                if (typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
                    update_nested_data(target_data[key], value, entity_index);
                } else {
                    target_data[key][entity_index] = value;
                }
            }
        };
        update_nested_data(this.data, data, entity);
    }

    static get_entity_data(entity) {
        const get_nested_data = (source_data, entity_index) => {
            const result = {};
            for (const [key, value] of Object.entries(source_data)) {
                if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
                    result[key] = get_nested_data(value, entity_index);
                } else if (ArrayBuffer.isView(value)) {
                    result[key] = value[entity_index];
                } else {
                    result[key] = value;
                }
            }
            return result;
        };

        if (!this.entity_set.has(entity)) {
            throw new Error(`Entity ${entity} does not exist in fragment ${this.constructor.name}`);
        }

        return get_nested_data(this.data, entity);
    }
}