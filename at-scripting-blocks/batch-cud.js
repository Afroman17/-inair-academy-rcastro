// Scripting Extension — Batch CUD practice.
// Rebuilds the whole Pokémon table in one run: deletes every record, fetches pokémon #1–#251
// from the PokéAPI and creates them in batches, sorted by number. Reuses the classes from
// create-pokemon.js (Airtable Scripting only allows one file, so they are copied here).

const Config = input.config({
    title: "📦 Pokédex Batch Loader",
    description: "Deletes every pokémon and recreates #1–#251 from the PokéAPI, in order.",
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
const FirstPokemonId = 1;
const LastPokemonId = 251;
// Parallel requests to the PokéAPI; keeps the run fast without hammering the API.
const FetchConcurrency = 10;
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


class PokemonBatchFetcher {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async fetchRange(firstId, lastId) {
        const ids = Array.from({ length: lastId - firstId + 1 }, (_, index) => firstId + index);
        const pokemon = [];
        for (const chunk of RecordBatcher.chunk(ids, FetchConcurrency)) {
            pokemon.push(...(await Promise.all(chunk.map((id) => this.apiClient.getPokemon(id)))));
            output.clear();
            output.markdown(`### 📡 Fetched ${pokemon.length} / ${ids.length} pokémon`);
        }
        return pokemon.sort((a, b) => a.id - b.id);
    }
}

class PokemonBatchRepository {
    async deleteAll() {
        const query = await PokemonTable.selectRecordsAsync({ fields: [] });
        const ids = query.records.map((record) => record.id);
        for (const chunk of RecordBatcher.chunk(ids)) {
            await PokemonTable.deleteRecordsAsync(chunk);
        }
        return ids.length;
    }

    async createAll(fieldsList) {
        // Sequential chunks keep the creation order equal to the pokémon number.
        let created = 0;
        for (const chunk of RecordBatcher.chunk(fieldsList)) {
            await PokemonTable.createRecordsAsync(chunk.map((fields) => ({ fields })));
            created += chunk.length;
        }
        return created;
    }
}

class BatchOrchestrator {
    constructor() {
        this.apiClient = new PokeApiClient(PokeApiUrl);
        this.fetcher = new PokemonBatchFetcher(this.apiClient);
        this.selectOptions = new SelectOptionsManager();
        this.typeResolver = ResolverFactory.types();
        this.abilityResolver = ResolverFactory.abilities(this.apiClient);
        this.mapper = new PokemonMapper(this.typeResolver, this.abilityResolver);
        this.repository = new PokemonBatchRepository();
    }

    async confirm() {
        output.markdown("## 📦 Pokédex Batch Loader");
        output.markdown(`This deletes **every** record in *${PokemonTable.name}* and recreates #${FirstPokemonId}–#${LastPokemonId}.`);
        const choice = await input.buttonsAsync("⚠️ Continue?", [
            { label: "🚀 Rebuild the Pokédex", value: true, variant: "danger" },
            { label: "Cancel", value: false },
        ]);
        return choice;
    }

    async prepareLinkedRecords(pokemonList) {
        // Resolve every Type/Ability up front so missing ones are created in batches, not one by one.
        await this.typeResolver.resolve(pokemonList.flatMap((pokemon) => pokemon.types.map((entry) => entry.type)));
        await this.abilityResolver.resolve(pokemonList.flatMap((pokemon) => pokemon.abilities.map((entry) => entry.ability)));
        await this.selectOptions.ensureChoices(PokemonFields.Games, pokemonList.flatMap((pokemon) => PokemonMapper.games(pokemon)));
    }

    async process() {
        if (!(await this.confirm())) {
            output.markdown("#### Cancelled, nothing changed 👌");
            return;
        }
        // Fetch everything before deleting, so a PokéAPI failure never leaves the table empty.
        const pokemonList = await this.fetcher.fetchRange(FirstPokemonId, LastPokemonId);
        await this.prepareLinkedRecords(pokemonList);
        const fieldsList = [];
        for (const pokemon of pokemonList) fieldsList.push(await this.mapper.toFields(pokemon));

        const deleted = await this.repository.deleteAll();
        const created = await this.repository.createAll(fieldsList);
        output.clear();
        output.markdown(`#### 🗑️ ${deleted} records deleted · ✨ ${created} pokémon created 🎉`);
    }
}

const orchestrator = new BatchOrchestrator();
await orchestrator.process();
