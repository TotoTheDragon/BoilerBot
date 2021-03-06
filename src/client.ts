import { Client, Collection } from "discord.js";
import { readdir, readFile, stat, writeFile } from "fs/promises";
import { Command } from "./objects/commands/Command";
import { Event } from "./objects/Event";
import { GuildWrapper } from "./objects/bot/GuildWrapper";
import { IModule } from "./objects/modules/IModule";
import { Pair } from "./objects/Pair";
import { Settings } from "./objects/bot/Settings";
import { doesFileExist, findFiles } from "./util/FileUtil";
import { ModuleSettings } from "./objects/bot/ModuleSettings";
import { StorageHolder, SQLWrapper, MySQLDatabase } from "simpledatabases";
import { GuildHolder } from "./objects/bot/GuildHolder";

export class WrappedClient extends Client {

    static instance: WrappedClient = null;


    // Module loading
    commands: Collection<string, Command>;
    aliases: Collection<string, Command>;

    modules: Collection<string, IModule>;
    settings: ModuleSettings;

    // Miscellaneous
    variables: Collection<string, any>;


    // Database stuff
    storageHolder: StorageHolder;
    mysql: SQLWrapper;

    constructor(options?) {
        super(options);
        // Modules
        this.commands = new Collection;
        this.aliases = new Collection;
        this.modules = new Collection;
        this.settings = new ModuleSettings();


        // Miscellaneous
        this.variables = new Collection;

        // Database
        this.storageHolder = new StorageHolder();

        WrappedClient.instance = this;
    }

    async initialize(): Promise<void> {
        await this.loadAllModules(true, true);
        await this.createSettings();
        await this.loadSettings();
        this.loadDatabase();
    }

    async indexModules(): Promise<Map<string, string>> {
        const folders = await Promise
            .all((await readdir("./modules/"))
                .filter(async f => (await stat(`./modules/${f}`)).isDirectory())
                .map(f => `./modules/${f}/`));

        folders.unshift("./");

        const modules: Map<string, string> = new Map();

        for (let i = 0; i < folders.length; i++) {
            const path = folders[i];
            const files = await findFiles(`${path}`, false);
            if (files.includes("Module.ts") || files.includes("Modules.js")) {
                let props = await import(`${path}/Module`);
                const module: IModule = new props[Object.keys(props)[0]]();
                this.modules.set(module.identifier, module);
                modules.set(module.identifier, path);
            }
        }

        return modules;
    }


    async loadAllModules(commands: boolean, events: boolean): Promise<Pair<number, number>> {
        return new Promise(async resolve => {
            if (commands) this.commands.clear();
            if (events) this.removeAllListeners();
            const modules: Map<string, string> = await this.indexModules();
            const mods = Array.from(modules);
            for (let i = 0; i < mods.length; i++) {
                await this.loadModule(commands, events, mods[i][1], mods[i][0]);
            }
            resolve(new Pair(commands ? this.commands.size : undefined, events ? this.getEventCount() : undefined));
        });
    }

    async loadModule(commands: boolean, events: boolean, path: string, module: string): Promise<void> {
        const loadedCmds = commands ? await this.loadCommands(module, path) : 0;
        const loadedEvents = events ? await this.loadEvents(module, path) : 0;
        this.modules.get(module).commands = loadedCmds;
        this.modules.get(module).events = loadedEvents;
        console.log(`Loaded module: ${this.modules.get(module).name}`)
        console.log(`Loaded ${loadedCmds} commands (Total ${this.commands.size})`);
        console.log(`Loaded ${loadedEvents} events (Total ${this.getEventCount()})`);
        console.log("--------------------");
    }

    async loadCommands(module: string, path: string): Promise<number> {
        return new Promise(async res => {
            const tsfiles = (await findFiles(`${path}commands`, true)).filter(f => !f.includes("subcommand")).filter(f => f.endsWith(".ts") || f.endsWith(".js"))
            if (tsfiles.length > 0)
                for (const file of tsfiles) {
                    let props = await import(`${path}commands/${file}`);
                    const com: Command = new props[Object.keys(props)[0]]();
                    com.module = module;
                    this.commands.set(com.label, com);
                    if (com.aliases) com.aliases.forEach(alias => this.aliases.set(alias, com));
                    delete require.cache[require.resolve(`${path}commands/${file}`)];
                }
            res(tsfiles.length);
        })
    }

    async loadEvents(module: string, path: string): Promise<number> {
        return new Promise(async res => {
            const tsfiles = (await findFiles(`${path}events/`, true)).filter(f => f.endsWith(".ts") || f.endsWith(".js"))
            if (tsfiles.length > 0)
                for (const file of tsfiles) {
                    const props = await import(`${path}events/${file}`);
                    const ev: Event = new props[Object.keys(props)[0]]();
                    ev.module = module;
                    if (ev.type === "on") this.on(ev.event as any, ev.listener.bind(null, this));
                    if (ev.type === "once") this.once(ev.event as any, ev.listener.bind(null, this));
                    delete require.cache[require.resolve(`${path}events/${file}`)];
                }
            res(tsfiles.length);
        })
    }

    async createSettings(): Promise<void> {
        return new Promise(async resolve => {
            if (!(await doesFileExist("./settings.json"))) await writeFile("./settings.json", JSON.stringify({}))
            const buffer = await readFile("./settings.json");
            const json: any = JSON.parse(buffer.toString())
            this.modules.forEach(module => {
                if (json[module.identifier] == undefined && module.getGlobalSettings().size > 0) json[module.identifier] = {};
                module.getGlobalSettings().forEach((value, key) => { if (json[module.identifier][key] == undefined) json[module.identifier][key] = value })
            })
            await writeFile("./settings.json", JSON.stringify(json, null, 2));
            resolve();
        });
    }

    async loadSettings(): Promise<void> {
        return new Promise(async resolve => {
            if (!(await doesFileExist("./settings.json"))) return console.log("Could not load settings file!");
            const buffer = await readFile("./settings.json");
            const json: any = JSON.parse(buffer.toString())
            this.modules.forEach(module => {
                module.getGlobalSettings().forEach((value, key) => {
                    this.settings.set(module.identifier, key, json[module.identifier] !== undefined ? json[module.identifier][key] : value);
                })
            })
            resolve();
        });
    }

    loadDatabase() {
        this.mysql = new MySQLDatabase({ user: "simpledb", password: "simpledb", database: "simpledb" });
        this.storageHolder.registerStorage(new GuildHolder(this.storageHolder, this.mysql));
    }

    getEventCount = () => this.eventNames().map(f => this.listenerCount(f)).reduce((a, b) => a + b);

    async getGuild(paramGuild: string): Promise<GuildWrapper> {
        return (this.storageHolder.getByType(new GuildWrapper()) as GuildHolder).getOrCreate(paramGuild);
    }

    async getGuildSettings(paramGuild: string): Promise<ModuleSettings> {
        return (await this.getGuild(paramGuild)).settings;
    }

    updateGuild(guild: GuildWrapper): Promise<void> {
        return (this.storageHolder.getByType(new GuildWrapper()) as GuildHolder).add(guild)
    }

    async updateGuildSettings(guild: string, settings: ModuleSettings): Promise<void> {
        let wrapper = await this.getGuild(guild);
        wrapper.settings = settings;
        return this.updateGuild(wrapper);
    }

    setVariable(module: string, name: string, variable: any) {
        this.variables.set(`${module}_${name}`, variable);
    }

    getVariable(module: string, name: string): any {
        return this.variables.get(`${module}_${name}`);
    }

}