document.addEventListener("DOMContentLoaded", async () => {
    // Set version
    let verEl = document.getElementById("version");
    if (verEl) {
        let man = chrome.runtime.getManifest();
        verEl.textContent = `v${man.version}`;
    }

    // ── Multi-city checklists (Consular / OFC) ──
    function renderCityList(containerId, allCities, selected, emptyText) {
        let container = document.getElementById(containerId);
        if (!container) return;
        allCities = allCities || {};
        selected = Array.isArray(selected) ? selected : [];
        let ids = Object.keys(allCities);
        if (!ids.length) {
            container.innerHTML = `<div class="nk-city-empty">${emptyText}</div>`;
            return;
        }
        container.innerHTML = "";
        ids.sort((a, b) => allCities[a].localeCompare(allCities[b])).forEach(id => {
            let row = document.createElement("label");
            row.className = "nk-city-item";
            let box = document.createElement("input");
            box.type = "checkbox";
            box.checked = selected.includes(id);
            box.dataset.cityId = id;
            let text = document.createElement("span");
            text.textContent = allCities[id];
            row.appendChild(box);
            row.appendChild(text);
            container.appendChild(row);
        });
    }

    async function toggleCitySelection(selectedKey, cityId, checked) {
        let stored = await chrome.storage.local.get([selectedKey]);
        let selected = Array.isArray(stored[selectedKey]) ? stored[selectedKey].slice() : [];
        if (checked && !selected.includes(cityId)) selected.push(cityId);
        if (!checked) selected = selected.filter(id => id !== cityId);
        await chrome.storage.local.set({ [selectedKey]: selected });
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "cities" }).catch(() => { });
    }

    async function loadCityLists() {
        let s = await chrome.storage.local.get(["__consularCities", "__consularSelectedCities", "__ofcCities", "__ofcSelectedCities"]);
        renderCityList("ofcCityList", s.__ofcCities, s.__ofcSelectedCities,
            "Visit either scheduling page once while active to load available locations.");
        renderCityList("consularCityList", s.__consularCities, s.__consularSelectedCities,
            "Visit either scheduling page once while active to load available locations.");
    }

    await loadCityLists();

    document.getElementById("consularCityList")?.addEventListener("change", e => {
        if (e.target && e.target.matches('input[type="checkbox"]')) {
            toggleCitySelection("__consularSelectedCities", e.target.dataset.cityId, e.target.checked);
        }
    });
    document.getElementById("ofcCityList")?.addEventListener("change", e => {
        if (e.target && e.target.matches('input[type="checkbox"]')) {
            toggleCitySelection("__ofcSelectedCities", e.target.dataset.cityId, e.target.checked);
        }
    });

    // Load stored settings
    await chrome.storage.local.get().then(s => {
        document.getElementById("currentUser").innerText = s.__usr || "Not signed in yet";
        document.getElementById("enable").checked = s.__act || false;
        document.getElementById("autobook").checked = s.__ab || false;
        document.getElementById("start").value = s.__st || new Date().toISOString().split("T")[0];
        document.getElementById("end").value = s.__en || "";
        document.getElementById("frequencyValue").value = s.__fq || 30;
        let ft = document.getElementById("frequencyType"), fqType = s.__fqType;
        for (let i = 0; i < ft.options.length; i++) {
            if (ft.options[i].value === fqType) { ft.selectedIndex = i; break; }
        }
        // Update status dot
        updateStatusDot(s.__act || false);
    });

    // Update user email
    let usr = await chrome.storage.local.get(["__usr"]);
    if (usr && usr.__usr) document.getElementById("currentUser").innerText = usr.__usr;

    // Status dot helper
    function updateStatusDot(active) {
        let dot = document.getElementById("statusDot");
        if (dot) {
            if (active) { dot.classList.remove("inactive"); }
            else { dot.classList.add("inactive"); }
        }
    }

    // Toggles
    chrome.storage.local.get(["__act", "__ab"], function (s) {
        let enEl = document.getElementById("enable");
        let abEl = document.getElementById("autobook");
        if (enEl) {
            enEl.checked = s.__act || false;
            updateStatusDot(s.__act || false);
            enEl.addEventListener("change", async function () {
                chrome.storage.local.set({ __act: this.checked });
                chrome.runtime.sendMessage({ action: "activate", status: this.checked });
                updateStatusDot(this.checked);
                let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "activate" }).catch(() => { });
            });
        }
        if (abEl) {
            abEl.checked = s.__ab || false;
            abEl.addEventListener("change", async function () {
                chrome.storage.local.set({ __ab: this.checked });
                let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "autobook" }).catch(() => { });
            });
        }
    });

    // Date inputs
    let endEl = document.getElementById("end");
    if (endEl) endEl.addEventListener("change", async function () {
        let ad = await chrome.storage.local.get("__ad").then(({ __ad: v }) => v);
        if (this.value) { if (ad && new Date(ad) <= new Date(this.value)) this.value = ad; }
        else this.value = ad || "";
        chrome.storage.local.set({ __en: this.value || "" });
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "until" }).catch(() => { });
    });

    let startEl = document.getElementById("start");
    if (startEl) startEl.addEventListener("change", async function () {
        chrome.storage.local.set({ __st: this.value || new Date().toISOString().split("T")[0] });
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "from" }).catch(() => { });
    });

    // Frequency
    document.getElementById("frequencyValue").addEventListener("change", async function () {
        let v = parseInt(this.value) || 30;
        if (v < 1) this.value = 1;
        if (v > 3600) this.value = 3600;
        chrome.storage.local.set({ __fq: parseInt(this.value) });
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequency" }).catch(() => { });
    });

    document.getElementById("frequencyType").addEventListener("change", async function () {
        chrome.storage.local.set({ __fqType: this.value });
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequencyType" }).catch(() => { });
    });

    // Reset button
    let resetBtn = document.getElementById("reset");
    if (resetBtn) resetBtn.addEventListener("click", e => {
        e.preventDefault();
        chrome.storage.local.clear(() => {
            if (chrome.runtime.lastError) console.warn("Error clearing local storage:", chrome.runtime.lastError.message);
        });
        chrome.storage.sync.clear(() => {
            if (chrome.runtime.lastError) console.warn("Error clearing sync storage:", chrome.runtime.lastError.message);
            chrome.storage.local.set({ __act: true }, () => {
                if (!chrome.runtime.lastError) {
                    let en = document.getElementById("enable");
                    if (en) en.checked = true;
                    updateStatusDot(true);
                    chrome.runtime.sendMessage({ action: "activate", status: true });
                }
            });
            chrome.tabs.query({}, function (tabs) {
                tabs.forEach(t => {
                    if (t && t.url && (t.url.includes("usvisascheduling.com") || t.url.includes("b2clogin.com"))) {
                        chrome.tabs.update(t.id, {
                            active: true,
                            url: "https://atlasauth.b2clogin.com/f50ebcfb-eadd-41d8-9099-a7049d073f5c/b2c_1a_atoproduction_atlas_susi/oauth2/v2.0/authorize?client_id=607d08d6-b63b-4735-ad82-05dfcff7efa4&redirect_uri=https%3A%2F%2Fwww.usvisascheduling.com%2Fsignin-aad-b2c_1&response_type=code%20id_token&scope=openid&state=OpenIdConnect.AuthenticationProperties%3D5XrhtASy0lDy45YNUBRkGd-900vuEPpZ0BMqu2e_OcAmpu7CIeAoVR0qwmxF--1e-nHZj_lDmVtUXqbOdjuYuVH3Mt9iowXBc3qLardexuysU186wstFl3aQDZj8GIBn7QMdF0z_GAuGfuK17xr65Jf2NM2Bn_gSq-H7BQK1s1VxES3tbt1h9YfTS_5TX1tO_TRNVjJLJ8OtP9sq3wK1p7itiDTBZrrDiK2Bjw8_j5RbKAB813kqAhKtqZeuBoW4XhX3RolaqpZJq4-6PMiRDKJwEDnd_gOURa9I4-6o6DTX4tnWFlrTsmHRM3z-nHRfEgve-3UR08NGBBpVVWu5m9vM2Bqj0fgHRcBJhOqJH4k5Xgn4Zh7thJYWxXSwgIlZ6FaOFV9zXLj-ZMVEdWHRP0nXFZNJ-rVBnlpOcnHBipjgXNZ6npH7KNzNkEzMLiwhXewwpivjGkZvJVnbArvXP9xfTcUsSnVN8ZNzsb2NqbiG555KSaIRAs02aJFuEO-BOmPcjAUPB6-i1g5xicV4LYhty_0xRuFTfSSFoxMuKyQChxDPPF1Dpsty6ZaA1UjRVYVXOdAvDCFQ4yNZ7924tOPa2igMutBq_rCOrdxni_tfwPtuCtIjDJZPsI8nUOFw&response_mode=form_post&nonce=638879731876911527.NmI2MmEzNmItYTc2ZC00NjE3LWE5MGEtZTlhZmRhYmMyNTVhNTQ2Zjg4MWMtM2EzMi00YWJkLTgzOTUtMmIwNjNmZmI4NjA0&ui_locales=en-US&x-client-SKU=ID_NET472&x-client-ver=6.35.0.0"
                        }, function () { setTimeout(() => { window.close() }, 100) });
                    }
                });
            });
        });
    });

    // Wake toggle
    document.getElementById("wake").addEventListener("change", async function () {
        let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) await chrome.tabs.sendMessage(tab.id, { action: "wake", value: this.checked });
    });

    // Storage change listener
    chrome.storage.onChanged.addListener(async (changes, area) => {
        if (changes.__st) {
            let v = changes.__st.newValue || new Date().toISOString().split("T")[0];
            document.getElementById("start").value = v;
        }
        if (changes.__en) {
            let v = changes.__en.newValue;
            let ad = await chrome.storage.local.get("__ad").then(({ __ad: x }) => x);
            if (v) { if (ad && new Date(ad) <= new Date(v)) v = ad; } else v = ad || "";
            document.getElementById("end").value = v;
        }
        if (changes.__act) {
            let v = changes.__act.newValue;
            document.getElementById("enable").checked = v;
            updateStatusDot(v);
        }
        if (changes.__ab) {
            document.getElementById("autobook").checked = changes.__ab.newValue;
        }
        if (changes.__fq) {
            document.getElementById("frequencyValue").value = changes.__fq.newValue;
        }
        if (changes.__fqType) {
            let ft = document.getElementById("frequencyType");
            let val = changes.__fqType.newValue;
            for (let i = 0; i < ft.options.length; i++) {
                if (ft.options[i].value === val) { ft.selectedIndex = i; break; }
            }
        }
        if (changes.__usr) {
            document.getElementById("currentUser").innerText = changes.__usr.newValue || "Not signed in yet";
        }
        if (changes.__consularCities || changes.__consularSelectedCities || changes.__ofcCities || changes.__ofcSelectedCities) {
            await loadCityLists();
        }
    });
});