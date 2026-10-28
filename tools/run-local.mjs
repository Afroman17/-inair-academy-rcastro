// Runs an Airtable Scripting Extension script locally against an in-memory base that mirrors
// the Pokédex template schema, using the real PokéAPI. Validates writes the way Airtable would.
//
//   node tools/run-local.mjs at-scripting-blocks/create-pokemon.js pikachu
//   node tools/run-local.mjs at-scripting-blocks/batch-cud.js
import { readFileSync } from "node:fs";

const [scriptPath, textAnswer = "pikachu"] = process.argv.slice(2);

const schema = {
    tblV008fIFh3llelC: {
        name: "Pokémon",
        fields: {
            fldcZAjs883ekI0PF: ["Name", "singleLineText"],
            fld61iiecp2FM7w0E: ["Sprites", "multipleAttachments"],
            fldqov5FBk9Rlyk68: ["Height", "number"],
            fldEcNYlyajSqnhOD: ["Weight", "number"],
            fldVswDRsBOFWY23Z: ["Base Experience", "number"],
            fldeEVLJoRXhTakJz: ["HP", "number"],
            fldd0IzOSbHHZAclA: ["Attack", "number"],
            fldj3ZB00WWGJSKe3: ["Defense", "number"],
            fldYtWXAoCoVPWo4a: ["Games", "multipleSelects", { choices: ["Red", "Blue", "Yellow", "Gold"].map((name) => ({ name })) }],
            fldXV8CGykB1Hx8ui: ["Types", "multipleRecordLinks", { linkedTableId: "tbl0NFSj2HeFNlLJG" }],
            fldgh4oumNM6lC148: ["Abilities", "multipleRecordLinks", { linkedTableId: "tblNBqh3aFwjatehw" }],
            fldCjUcPMLvqoZIsA: ["Generation", "singleSelect", { choices: [{ name: "Generation I" }, { name: "Generation II" }] }],
            fldVq5zP3DkGmIePg: ["APIURL", "url"],
            fldef2w7fReILFRvr: ["Order", "number"],
        },
    },
    tbl0NFSj2HeFNlLJG: {
        name: "Types",
        fields: { fldhMf3wsa0QMIxdJ: ["Name", "singleLineText"], fld0dKjTnFhiOILdk: ["APIURL", "url"] },
    },
    tblNBqh3aFwjatehw: {
        name: "Abilities",
        fields: {
            fld4A0sgA8iu9Q0Lz: ["Name", "singleLineText"],
            fldgyEee80CtkmQi8: ["Effect", "richText"],
            fldN1vIDvDzWbQeLa: ["APIURL", "url"],
        },
    },
};

let idCounter = 0;
const newId = () => `rec${String(++idCounter).padStart(14, "0")}`;
const stats = { creates: 0, updates: 0, deletes: 0, maxBatch: 0 };

class FakeField {
    constructor(table, id, [name, type, options]) {
        Object.assign(this, { table, id, name, type, options: options ?? null });
    }
    async updateOptionsAsync(options) {
        this.options = { ...this.options, ...options };
    }
}

class FakeRecord {
    constructor(table, id, cells) {
        Object.assign(this, { table, id, cells });
    }
    getCellValue(field) {
        return this.cells[this.table.getField(field).id] ?? null;
    }
    getCellValueAsString(field) {
        const value = this.getCellValue(field);
        return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
}

class FakeTable {
    constructor(base, id, def) {
        Object.assign(this, { base, id, name: def.name, records: new Map() });
        this.fields = Object.entries(def.fields).map(([fid, spec]) => new FakeField(this, fid, spec));
    }
    getField(idOrField) {
        const key = idOrField?.id ?? idOrField;
        const field = this.fields.find((f) => f.id === key);
        if (!field) throw new Error(`${this.name}: no field ${key}`);
        return field;
    }
    validate(cells) {
        for (const [key, value] of Object.entries(cells)) {
            const field = this.getField(key);
            if (value === undefined) throw new Error(`${field.name}: undefined value`);
            if (value === null) continue;
            const check = {
                singleLineText: () => typeof value === "string",
                richText: () => typeof value === "string",
                url: () => typeof value === "string" && value.startsWith("http"),
                number: () => typeof value === "number" && Number.isFinite(value),
                multipleAttachments: () => Array.isArray(value) && value.every((a) => a.url?.startsWith("http")),
                singleSelect: () => field.options.choices.some((c) => c.name === value.name),
                multipleSelects: () => value.every((v) => field.options.choices.some((c) => c.name === v.name)),
                multipleRecordLinks: () => value.every((v) => this.base.getTable(field.options.linkedTableId).records.has(v.id)),
            }[field.type];
            if (!check()) throw new Error(`${this.name}.${field.name}: invalid value ${JSON.stringify(value)}`);
        }
        return Object.fromEntries(Object.entries(cells).map(([k, v]) => [this.getField(k).id, v]));
    }
    trackBatch(n) {
        if (n > 50) throw new Error(`${this.name}: batch of ${n} exceeds Airtable's 50 limit`);
        stats.maxBatch = Math.max(stats.maxBatch, n);
    }
    async selectRecordsAsync() {
        return { records: [...this.records.values()] };
    }
    async createRecordAsync(cells) {
        return (await this.createRecordsAsync([{ fields: cells }]))[0];
    }
    async createRecordsAsync(list) {
        this.trackBatch(list.length);
        return list.map(({ fields }) => {
            const id = newId();
            this.records.set(id, new FakeRecord(this, id, this.validate(fields)));
            stats.creates++;
            return id;
        });
    }
    async updateRecordAsync(recordOrId, cells) {
        const record = this.records.get(recordOrId.id ?? recordOrId);
        Object.assign(record.cells, this.validate(cells));
        stats.updates++;
    }
    async deleteRecordsAsync(ids) {
        this.trackBatch(ids.length);
        ids.forEach((id) => this.records.delete(id.id ?? id) && stats.deletes++);
    }
}

const base = { tables: [] };
base.getTable = (id) => base.tables.find((t) => t.id === id || t.name === id);
for (const [id, def] of Object.entries(schema)) base.tables.push(new FakeTable(base, id, def));
const [pokemonTable, typesTable] = base.tables;

// Seed like the template: a couple of pre-existing types and stale pokémon to be wiped.
await typesTable.createRecordsAsync([
    { fields: { fldhMf3wsa0QMIxdJ: "Electric", fld0dKjTnFhiOILdk: "https://pokeapi.co/api/v2/type/13/" } },
    { fields: { fldhMf3wsa0QMIxdJ: "Fire", fld0dKjTnFhiOILdk: "https://pokeapi.co/api/v2/type/10" } },
]);
await pokemonTable.createRecordsAsync([{ fields: { fldcZAjs883ekI0PF: "Pikachu" } }, { fields: { fldcZAjs883ekI0PF: "Stale" } }]);

const config = (spec) => Object.fromEntries(spec.items.map((item) => [item.key, base.getTable(item.default)]));
config.table = (key, { label } = {}) => ({ key, default: { PokemonTable: "Pokémon", TypesTable: "Types", AbilitiesTable: "Abilities" }[key] ?? label });
const input = {
    config,
    textAsync: async () => textAnswer,
    buttonsAsync: async (_label, options) => options[0].value,
    recordAsync: async (_label, table) => [...table.records.values()][0],
};
const output = { markdown: (text) => console.log(`[output] ${text}`), clear: () => {} };
const quietConsole = { log: (value) => console.log(`[console.log] ${typeof value === "object" ? `{${Object.keys(value).slice(0, 6).join(", ")}, …}` : value}`) };

const code = readFileSync(scriptPath, "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const started = Date.now();
await new AsyncFunction("base", "input", "output", "remoteFetchAsync", "console", code)(base, input, output, fetch, quietConsole);

const name = (table, rec) => rec.getCellValueAsString(table.getField(table.fields[0]));
const pokemon = [...pokemonTable.records.values()];
console.log(`\n${scriptPath} done in ${((Date.now() - started) / 1000).toFixed(1)}s`, stats);
console.log(`Pokémon: ${pokemon.length} · Types: ${typesTable.records.size} · Abilities: ${base.tables[2].records.size}`);
const orders = pokemon.map((r) => r.cells.fldef2w7fReILFRvr).filter((o) => o != null);
console.log("Creation order sorted:", orders.every((o, i) => i === 0 || o > orders[i - 1]));
const emptyFields = pokemon.flatMap((r) =>
    pokemonTable.fields.filter((f) => r.cells.fldef2w7fReILFRvr && (r.cells[f.id] == null || r.cells[f.id]?.length === 0)).map((f) => `${name(pokemonTable, r)}.${f.name}`),
);
console.log("Empty fields on fetched pokémon:", emptyFields.length ? emptyFields.slice(0, 20) : "none");
const sample = pokemon.find((r) => r.cells.fldef2w7fReILFRvr === 25) ?? pokemon.at(-1);
console.log("Sample:", JSON.stringify(Object.fromEntries(Object.entries(sample.cells).map(([k, v]) => [pokemonTable.getField(k).name, v]))).slice(0, 900));
console.log("Odd names:", pokemon.map((r) => name(pokemonTable, r)).filter((n) => /[^A-Za-z]/.test(n)));
