// Scripting Extension — run from the "Fetch PokeData" button on the Pokémon table.
// Reads the name of the clicked record, GETs that pokémon from the PokéAPI and logs it.

const Config = input.config({
    title: "⚡ Fetch PokeData",
    description: "Fetches a single pokémon from the PokéAPI using the name of the clicked record.",
    items: [
        input.config.table("PokemonTable", { label: "Pokémon table" }),
    ],
});

const PokemonTable = Config.PokemonTable;
const PokemonName = PokemonTable.getField("fldcZAjs883ekI0PF");
const PokeApiUrl = "https://pokeapi.co/api/v2";

class PokeApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async getPokemon(nameOrId) {
        const slug = String(nameOrId).trim().toLowerCase();
        const response = await remoteFetchAsync(`${this.baseUrl}/pokemon/${slug}`);
        if (!response.ok) {
            throw new Error(`PokéAPI returned ${response.status} for "${slug}"`);
        }
        return response.json();
    }
}

class FetchOrchestrator {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async pickRecord() {
        // When launched from a button field, the clicked record is picked automatically.
        return input.recordAsync("🔎 Pick a pokémon", PokemonTable);
    }

    async process() {
        const record = await this.pickRecord();
        if (!record) {
            output.markdown("#### No record selected 🤷");
            return;
        }
        const name = record.getCellValueAsString(PokemonName);
        output.markdown(`## ⚡ Fetching **${name}**…`);
        const pokemon = await this.apiClient.getPokemon(name);
        console.log(pokemon);
        output.markdown(`#### #${pokemon.id} ${pokemon.name} fetched successfully 🎉`);
    }
}

const orchestrator = new FetchOrchestrator(new PokeApiClient(PokeApiUrl));
await orchestrator.process();
