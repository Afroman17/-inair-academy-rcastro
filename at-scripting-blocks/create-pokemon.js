// Scripting Extension — CRUD practice.
// Asks for a pokémon (name or number), fetches it from the PokéAPI and fills EVERY editable
// field of the Pokémon table: creates the record if it doesn't exist, updates it if it does.
// Types and Abilities are linked records: existing ones are matched by their API URL and the
// missing ones are created on the fly.

const Config = input.config({
    title: "🧬 Pokémon Creator",
    description: "Creates (or updates) a pokémon record with every field filled from the PokéAPI.",
    items: [
        input.config.table("PokemonTable", { label: "Pokémon table" }),
        input.config.table("TypesTable", { label: "Types table" }),
        input.config.table("AbilitiesTable", { label: "Abilities table" }),
    ],
});

const PokemonTable = Config.PokemonTable;
const TypesTable = Config.TypesTable;
const AbilitiesTable = Config.AbilitiesTable;

const PokemonFields = {
    Name: PokemonTable.getField("fldcZAjs883ekI0PF"),
    Sprites: PokemonTable.getField("fld61iiecp2FM7w0E"),
    Height: PokemonTable.getField("fldqov5FBk9Rlyk68"),
    Weight: PokemonTable.getField("fldEcNYlyajSqnhOD"),
    BaseExperience: PokemonTable.getField("fldVswDRsBOFWY23Z"),
    Hp: PokemonTable.getField("fldeEVLJoRXhTakJz"),
    Attack: PokemonTable.getField("fldd0IzOSbHHZAclA"),
    Defense: PokemonTable.getField("fldj3ZB00WWGJSKe3"),
    Games: PokemonTable.getField("fldYtWXAoCoVPWo4a"),
    Types: PokemonTable.getField("fldXV8CGykB1Hx8ui"),
    Abilities: PokemonTable.getField("fldgh4oumNM6lC148"),
    Generation: PokemonTable.getField("fldCjUcPMLvqoZIsA"),
    ApiUrl: PokemonTable.getField("fldVq5zP3DkGmIePg"),
    Order: PokemonTable.getField("fldef2w7fReILFRvr"),
};
const TypeFields = {
    Name: TypesTable.getField("fldhMf3wsa0QMIxdJ"),
    ApiUrl: TypesTable.getField("fld0dKjTnFhiOILdk"),
};
const AbilityFields = {
    Name: AbilitiesTable.getField("fld4A0sgA8iu9Q0Lz"),
    Effect: AbilitiesTable.getField("fldgyEee80CtkmQi8"),
    ApiUrl: AbilitiesTable.getField("fldN1vIDvDzWbQeLa"),
};

const PokeApiUrl = "https://pokeapi.co/api/v2";
const SpriteKeys = ["front_default", "back_default", "front_shiny", "back_shiny"];
const GamesToKeep = 4;
// Airtable accepts at most 50 records per create/update/delete call.
const BatchSize = 50;
// Hint from the training: #1–#151 is Generation I and #152–#251 is Generation II.
const Generations = [
    { lastId: 151, name: "Generation I" },
    { lastId: 251, name: "Generation II" },
];
// PokéAPI slugs whose display name can't be derived by capitalizing.
const NameExceptions = {
    "nidoran-f": "Nidoran♀",
    "nidoran-m": "Nidoran♂",
    "mr-mime": "Mr. Mime",
    "farfetchd": "Farfetch'd",
    "ho-oh": "Ho-Oh",
};
const GameNameExceptions = {
    firered: "Fire Red",
    leafgreen: "Leaf Green",
    heartgold: "Heart Gold",
    soulsilver: "Soul Silver",
};

class PokeApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async getJson(url) {
        const response = await remoteFetchAsync(url);
        if (!response.ok) {
            throw new Error(`PokéAPI returned ${response.status} for ${url}`);
        }
        return response.json();
    }

    getPokemon(nameOrId) {
        const slug = String(nameOrId).trim().toLowerCase().replace(/\s+/g, "-");
        return this.getJson(`${this.baseUrl}/pokemon/${slug}`);
    }

    getAbility(url) {
        return this.getJson(url);
    }
}

class TextFormatter {
    static capitalize(slug) {
        return slug
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    static pokemonName(slug) {
        return NameExceptions[slug] ?? TextFormatter.capitalize(slug);
    }

    static gameName(slug) {
        return GameNameExceptions[slug] ?? TextFormatter.capitalize(slug);
    }

    static normalizeUrl(url) {
        return String(url ?? "").trim().replace(/\/?$/, "/");
    }
}

class SelectOptionsManager {
    // Adds the select choices that don't exist yet, so writes by name never fail.
    async ensureChoices(field, names) {
        const existing = new Set(field.options.choices.map((choice) => choice.name));
        const missing = [...new Set(names)].filter((name) => !existing.has(name));
        if (missing.length === 0) return;
        await field.updateOptionsAsync({
            choices: [...field.options.choices, ...missing.map((name) => ({ name }))],
        });
    }
}

class LinkedRecordResolver {
    // Resolves PokéAPI references ({name, url}) to record ids of a linked table,
    // creating the records that don't exist yet.
    constructor(table, fields, buildNewRecordFields) {
        this.table = table;
        this.fields = fields;
        this.buildNewRecordFields = buildNewRecordFields;
        this.idByUrl = null;
    }

    async loadIndex() {
        if (this.idByUrl) return;
        const query = await this.table.selectRecordsAsync({ fields: [this.fields.ApiUrl] });
        this.idByUrl = new Map();
        for (const record of query.records) {
            const url = record.getCellValueAsString(this.fields.ApiUrl);
            if (url) this.idByUrl.set(TextFormatter.normalizeUrl(url), record.id);
        }
    }

    async resolve(references) {
        await this.loadIndex();
        const missing = references.filter(
            (reference) => !this.idByUrl.has(TextFormatter.normalizeUrl(reference.url)),
        );
        const uniqueMissing = [...new Map(missing.map((ref) => [TextFormatter.normalizeUrl(ref.url), ref])).values()];
        for (const chunk of RecordBatcher.chunk(uniqueMissing)) {
            const payload = await Promise.all(chunk.map((reference) => this.buildNewRecordFields(reference)));
            const ids = await this.table.createRecordsAsync(payload.map((fields) => ({ fields })));
            chunk.forEach((reference, index) => this.idByUrl.set(TextFormatter.normalizeUrl(reference.url), ids[index]));
        }
        return references.map((reference) => ({ id: this.idByUrl.get(TextFormatter.normalizeUrl(reference.url)) }));
    }
}

class RecordBatcher {
    static chunk(items, size = BatchSize) {
        const chunks = [];
        for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
        return chunks;
    }
}

class PokemonMapper {
    constructor(typeResolver, abilityResolver) {
        this.typeResolver = typeResolver;
        this.abilityResolver = abilityResolver;
    }

    static stat(pokemon, statName) {
        return pokemon.stats.find((entry) => entry.stat.name === statName)?.base_stat ?? null;
    }

    static generation(id) {
        const generation = Generations.find((entry) => id <= entry.lastId);
        if (!generation) throw new Error(`#${id} is outside the supported generations`);
        return generation.name;
    }

    static sprites(pokemon) {
        return SpriteKeys.filter((key) => pokemon.sprites[key])
            .map((key) => ({ url: pokemon.sprites[key], filename: `${pokemon.name}-${key}.png` }));
    }

    static games(pokemon) {
        return pokemon.game_indices
            .slice(0, GamesToKeep)
            .map((entry) => TextFormatter.gameName(entry.version.name));
    }

    // Fields that don't depend on other tables (used to precompute select choices in batch).
    static scalarFields(pokemon) {
        return {
            [PokemonFields.Name.id]: TextFormatter.pokemonName(pokemon.name),
            [PokemonFields.Sprites.id]: PokemonMapper.sprites(pokemon),
            [PokemonFields.Height.id]: pokemon.height / 10, // decimetres → metres
            [PokemonFields.Weight.id]: pokemon.weight / 10, // hectograms → kilograms
            [PokemonFields.BaseExperience.id]: pokemon.base_experience,
            [PokemonFields.Hp.id]: PokemonMapper.stat(pokemon, "hp"),
            [PokemonFields.Attack.id]: PokemonMapper.stat(pokemon, "attack"),
            [PokemonFields.Defense.id]: PokemonMapper.stat(pokemon, "defense"),
            [PokemonFields.Games.id]: PokemonMapper.games(pokemon).map((name) => ({ name })),
            [PokemonFields.Generation.id]: { name: PokemonMapper.generation(pokemon.id) },
            [PokemonFields.ApiUrl.id]: `${PokeApiUrl}/pokemon/${pokemon.id}/`,
            [PokemonFields.Order.id]: pokemon.id,
        };
    }

    async toFields(pokemon) {
        const types = await this.typeResolver.resolve(pokemon.types.map((entry) => entry.type));
        const abilities = await this.abilityResolver.resolve(pokemon.abilities.map((entry) => entry.ability));
        return {
            ...PokemonMapper.scalarFields(pokemon),
            [PokemonFields.Types.id]: types,
            [PokemonFields.Abilities.id]: abilities,
        };
    }
}

class ResolverFactory {
    static types() {
        return new LinkedRecordResolver(TypesTable, TypeFields, async (reference) => ({
            [TypeFields.Name.id]: TextFormatter.capitalize(reference.name),
            [TypeFields.ApiUrl.id]: TextFormatter.normalizeUrl(reference.url),
        }));
    }

    static abilities(apiClient) {
        return new LinkedRecordResolver(AbilitiesTable, AbilityFields, async (reference) => {
            const ability = await apiClient.getAbility(reference.url);
            const english = ability.effect_entries.find((entry) => entry.language.name === "en");
            return {
                [AbilityFields.Name.id]: TextFormatter.capitalize(reference.name),
                [AbilityFields.Effect.id]: english?.effect ?? english?.short_effect ?? "",
                [AbilityFields.ApiUrl.id]: TextFormatter.normalizeUrl(reference.url),
            };
        });
    }
}

class PokemonRepository {
    async findByUrlOrName(apiUrl, name) {
        const query = await PokemonTable.selectRecordsAsync({
            fields: [PokemonFields.Name, PokemonFields.ApiUrl],
        });
        return query.records.find(
            (record) =>
                TextFormatter.normalizeUrl(record.getCellValueAsString(PokemonFields.ApiUrl)) === apiUrl ||
                record.getCellValueAsString(PokemonFields.Name).toLowerCase() === name.toLowerCase(),
        );
    }

    async upsert(fields) {
        const apiUrl = fields[PokemonFields.ApiUrl.id];
        const existing = await this.findByUrlOrName(apiUrl, fields[PokemonFields.Name.id]);
        if (existing) {
            await PokemonTable.updateRecordAsync(existing, fields);
            return { id: existing.id, created: false };
        }
        const id = await PokemonTable.createRecordAsync(fields);
        return { id, created: true };
    }
}

class CreateOrchestrator {
    constructor() {
        this.apiClient = new PokeApiClient(PokeApiUrl);
        this.selectOptions = new SelectOptionsManager();
        this.mapper = new PokemonMapper(ResolverFactory.types(), ResolverFactory.abilities(this.apiClient));
        this.repository = new PokemonRepository();
    }

    async runWizard() {
        output.markdown("## 🧬 Create a Pokémon");
        const answer = await input.textAsync("🔢 Pokémon name or number (e.g. pikachu or 25)");
        if (!answer?.trim()) throw new Error("A pokémon name or number is required");
        return answer;
    }

    async process() {
        const nameOrId = await this.runWizard();
        const pokemon = await this.apiClient.getPokemon(nameOrId);
        console.log(pokemon);
        await this.selectOptions.ensureChoices(PokemonFields.Games, PokemonMapper.games(pokemon));
        const fields = await this.mapper.toFields(pokemon);
        const result = await this.repository.upsert(fields);
        const verb = result.created ? "created" : "updated";
        output.markdown(`#### #${pokemon.id} ${fields[PokemonFields.Name.id]} ${verb} successfully 🎉`);
    }
}

const orchestrator = new CreateOrchestrator();
await orchestrator.process();
