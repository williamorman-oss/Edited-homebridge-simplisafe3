const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const distPackage = require(path.join(distDir, 'package.json'));
const configSchema = require(path.join(distDir, 'config.schema.json'));

// mirrors homebridge's plugin loader
function loadPluginInitializer() {
    const pluginModule = require(path.join(distDir, distPackage.main));
    return typeof pluginModule === 'function' ? pluginModule : pluginModule.default;
}

test('dist package main resolves to a plugin initializer function', () => {
    assert.ok(fs.existsSync(path.join(distDir, distPackage.main)));
    assert.equal(typeof loadPluginInitializer(), 'function');
});

test('plugin initializer registers the platform with homebridge', () => {
    const calls = [];
    const api = {
        hap: { uuid: { generate: () => 'uuid' } },
        registerPlatform: (...args) => calls.push(args),
    };

    loadPluginInitializer()(api);

    assert.equal(calls.length, 1);
    const [pluginName, platformName, constructor, dynamic] = calls[0];
    assert.equal(pluginName, distPackage.name);
    assert.equal(platformName, 'SimpliSafe 3 Edited');
    assert.equal(typeof constructor, 'function');
    assert.equal(dynamic, true);
});

test('config schema alias matches the registered platform', () => {
    let registered;
    loadPluginInitializer()({
        hap: { uuid: {} },
        registerPlatform: (pluginName, platformName) => {
            registered = `${pluginName}.${platformName}`;
        },
    });

    assert.equal(configSchema.pluginAlias, registered);
});

test('oclif login command is present in dist', () => {
    const commandsDir = path.join(distDir, distPackage.oclif.commands);
    const Login = require(path.join(commandsDir, 'login.js'));

    assert.equal(typeof Login, 'function');
    assert.equal(typeof Login.run, 'function');
    assert.ok(fs.existsSync(path.join(distDir, distPackage.bin[distPackage.name])));
});

test('every list in the settings form has an item layout, so Homebridge UI shows its input and Add button', () => {
    // Homebridge UI's form only draws a list's rows and Add button when the layout names its items
    const schemaAt = (key) => key.split('.').reduce((node, part) => node && node.properties && node.properties[part], configSchema.schema);
    const nodes = [];
    const walk = (items) => (items || []).forEach((item) => {
        if (typeof item === 'string') nodes.push({ key: item });
        else if (item.key) nodes.push(item);
        if (item && item.items) walk(item.items.filter((i) => !(i && typeof i.key === 'string' && i.key.endsWith('[]'))));
    });
    walk(configSchema.layout);

    const lists = nodes.filter((node) => !node.key.endsWith('[]') && schemaAt(node.key) && schemaAt(node.key).type === 'array');
    assert.deepEqual(lists.map((node) => node.key).sort(), ['cameraOptions.alwaysConnected', 'cameraOptions.record', 'excludedDevices']);
    for (const node of lists) {
        assert.ok(Array.isArray(node.items) && node.items.length, `${node.key} has no item layout`);
        assert.ok(node.buttonText, `${node.key} has no Add button text`);
    }
});
