document.addEventListener("DOMContentLoaded", async () => {
    const $ = (id) => document.getElementById(id);

    $("version").textContent = "v" + chrome.runtime.getManifest().version;

    /* ── Location lists ────────────────────────────────────────── */
    function renderCityList(containerId, allCities, selected) {
        const container = $(containerId);
        if (!container) return;
        allCities = allCities || {};
        selected = Array.isArray(selected) ? selected : [];
        const ids = Object.keys(allCities);
        if (!ids.length) {
            container.innerHTML = `<div class="fp-city-empty">Visit the matching scheduling page once to load locations.</div>`;
            return;
        }
        container.innerHTML = "";
        ids.sort((a, b) => allCities[a].localeCompare(allCities[b])).forEach(id => {
            const row = document.createElement("label");
            row.className = "fp-city-item";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = selected.includes(id);
            box.dataset.cityId = id;
            const text = document.createElement("span");
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
        else if (!checked) selected = selected.filter(id => id !== cityId);
        await chrome.storage.local.set({ [selectedKey]: selected });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "cities" }).catch(() => { });
    }

    async function updateLocationsSummary() {
        const s = await chrome.storage.local.get(["__ofcSelectedCities", "__consularSelectedCities"]);
        const ofc = (s.__ofcSelectedCities || []).length;
        const con = (s.__consularSelectedCities || []).length;
        const parts = [];
        if (ofc) parts.push(ofc + " OFC");
        if (con) parts.push(con + " Consular");
        $("locationsSummary").textContent = parts.length ? parts.join(" · ") : "None selected";
    }

    async function loadCityLists() {
        const s = await chrome.storage.local.get(["__consularCities", "__consularSelectedCities", "__ofcCities", "__ofcSelectedCities"]);
        renderCityList("ofcCityList", s.__ofcCities, s.__ofcSelectedCities);
        renderCityList("consularCityList", s.__consularCities, s.__consularSelectedCities);
        await updateLocationsSummary();
    }

    await loadCityLists();

    $("consularCityList").addEventListener("change", async e => {
        if (e.target?.matches('input[type="checkbox"]')) {
            await toggleCitySelection("__consularSelectedCities", e.target.dataset.cityId, e.target.checked);
            await updateLocationsSummary();
        }
    });
    $("ofcCityList").addEventListener("change", async e => {
        if (e.target?.matches('input[type="checkbox"]')) {
            await toggleCitySelection("__ofcSelectedCities", e.target.dataset.cityId, e.target.checked);
            await updateLocationsSummary();
        }
    });

    /* ── Collapsible location groups ───────────────────────────── */
    document.querySelectorAll(".fp-loc-head").forEach(head => {
        head.addEventListener("click", () => {
            const group = head.closest(".fp-loc-group");
            group.classList.toggle("open");
        });
    });
    document.querySelectorAll(".fp-loc-group").forEach(g => g.classList.add("open"));

    /* ── Hero status + power button ────────────────────────────── */
    function renderRunState(active) {
        const hero = $("heroStatus");
        hero.classList.toggle("active", !!active);
        $("heroText").textContent = active ? "Scanning" : "Idle";
        document.body.classList.toggle("fp-running", !!active);
        $("powerLabel").textContent = active ? "Stop scanning" : "Start scanning";
    }

    /* ── Date-range hint ───────────────────────────────────────── */
    function renderDatesHint() {
        const s = $("start").value, e = $("end").value;
        const el = $("datesHint");
        if (!s || !e) {
            el.textContent = "Set both dates to begin.";
            el.classList.remove("ok");
        } else {
            const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000) + 1);
            el.textContent = `Watching ${days} day${days === 1 ? "" : "s"} · ${s} → ${e}`;
            el.classList.add("ok");
        }
    }

    /* ── Initial load ──────────────────────────────────────────── */
    const s0 = await chrome.storage.local.get();
    $("currentUser").textContent = s0.__usr || "Not signed in";
    $("enable").checked = !!s0.__act;
    $("autobook").checked = !!s0.__ab;
    $("wake").checked = !!s0.__wake;
    $("start").value = s0.__st || new Date().toISOString().split("T")[0];
    $("end").value = s0.__en || "";
    $("frequencyValue").value = s0.__fq || 30;
    const fqType = s0.__fqType || "seconds";
    for (const opt of $("frequencyType").options) {
        if (opt.value === fqType) { opt.selected = true; break; }
    }
    renderRunState(!!s0.__act);
    renderDatesHint();

    /* ── Wire controls ─────────────────────────────────────────── */
    $("enable").addEventListener("change", async function () {
        chrome.storage.local.set({ __act: this.checked });
        chrome.runtime.sendMessage({ action: "activate", status: this.checked });
        renderRunState(this.checked);
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "activate" }).catch(() => { });
    });

    $("autobook").addEventListener("change", async function () {
        chrome.storage.local.set({ __ab: this.checked });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "autobook" }).catch(() => { });
    });

    $("start").addEventListener("change", async function () {
        chrome.storage.local.set({ __st: this.value || new Date().toISOString().split("T")[0] });
        renderDatesHint();
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "from" }).catch(() => { });
    });

    $("end").addEventListener("change", async function () {
        const { __ad: ad } = await chrome.storage.local.get("__ad");
        if (this.value) { if (ad && new Date(ad) <= new Date(this.value)) this.value = ad; }
        else this.value = ad || "";
        chrome.storage.local.set({ __en: this.value || "" });
        renderDatesHint();
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "until" }).catch(() => { });
    });

    $("frequencyValue").addEventListener("change", async function () {
        let v = parseInt(this.value) || 30;
        if (v < 1) { v = 1; this.value = 1; }
        if (v > 3600) { v = 3600; this.value = 3600; }
        chrome.storage.local.set({ __fq: v });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequency" }).catch(() => { });
    });

    $("frequencyType").addEventListener("change", async function () {
        chrome.storage.local.set({ __fqType: this.value });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequencyType" }).catch(() => { });
    });

    $("wake").addEventListener("change", async function () {
        chrome.storage.local.set({ __wake: this.checked });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "wake", value: this.checked });
    });

    $("reset").addEventListener("click", (e) => {
        e.preventDefault();
        chrome.storage.local.clear(() => {
            chrome.storage.sync.clear(() => {
                chrome.storage.local.set({ __act: true }, () => {
                    $("enable").checked = true;
                    renderRunState(true);
                    chrome.runtime.sendMessage({ action: "activate", status: true });
                });
            });
            chrome.tabs.query({}, function (tabs) {
                tabs.forEach(t => {
                    if (t && t.url && (t.url.includes("usvisascheduling.com") || t.url.includes("b2clogin.com"))) {
                        chrome.tabs.update(t.id, {
                            active: true,
                            url: "https://atlasauth.b2clogin.com/f50ebcfb-eadd-41d8-9099-a7049d073f5c/b2c_1a_atoproduction_atlas_susi/oauth2/v2.0/authorize?client_id=607d08d6-b63b-4735-ad82-05dfcff7efa4&redirect_uri=https%3A%2F%2Fwww.usvisascheduling.com%2Fsignin-aad-b2c_1&response_type=code%20id_token&scope=openid&state=OpenIdConnect.AuthenticationProperties%3D5XrhtASy0lDy45YNUBRkGd-900vuEPpZ0BMqu2e_OcAmpu7CIeAoVR0qwmxF--1e-nHZj_lDmVtUXqbOdjuYuVH3Mt9iowXBc3qLardexuysU186wstFl3aQDZj8GIBn7QMdF0z_GAuGfuK17xr65Jf2NM2Bn_gSq-H7BQK1s1VxES3tbt1h9YfTS_5TX1tO_TRNVjJLJ8OtP9sq3wK1p7itiDTBZrrDiK2Bjw8_j5RbKAB813kqAhKtqZeuBoW4XhX3RolaqpZJq4-6PMiRDKJwEDnd_gOURa9I4-6o6DTX4tnWFlrTsmHRM3z-nHRfEgve-3UR08NGBBpVVWu5m9vM2Bqj0fgHRcBJhOqJH4k5Xgn4Zh7thJYWxXSwgIlZ6FaOFV9zXLj-ZMVEdWHRP0nXFZNJ-rVBnlpOcnHBipjgXNZ6npH7KNzNkEzMLiwhXewwpivjGkZvJVnbArvXP9xfTcUsSnVN8ZNzsb2NqbiG555KSaIRAs02aJFuEO-BOmPcjAUPB6-i1g5xicV4LYhty_0xRuFTfSSFoxMuKyQChxDPPF1Dpsty6ZaA1UjRVYVXOdAvDCFQ4yNZ7924tOPa2igMutBq_rCOrdxni_tfwPtuCtIjDJZPsI8nUOFw&response_mode=form_post&nonce=638879731876911527.NmI2MmEzNmItYTc2ZC00NjE3LWE5MGEtZTlhZmRhYmMyNTVhNTQ2Zjg4MWMtM2EzMi00YWJkLTgzOTUtMmIwNjNmZmI4NjA0&ui_locales=en-US&x-client-SKU=ID_NET472&x-client-ver=6.35.0.0"
                        }, () => setTimeout(() => window.close(), 100));
                    }
                });
            });
        });
    });

    /* ── Live sync from storage ────────────────────────────────── */
    chrome.storage.onChanged.addListener((changes, area) => {
        if (changes.__st) { $("start").value = changes.__st.newValue || new Date().toISOString().split("T")[0]; renderDatesHint(); }
        if (changes.__en) {
            chrome.storage.local.get("__ad").then(({ __ad: ad }) => {
                let v = changes.__en.newValue;
                if (v) { if (ad && new Date(ad) <= new Date(v)) v = ad; } else v = ad || "";
                $("end").value = v;
                renderDatesHint();
            });
        }
        if (changes.__act) {
            $("enable").checked = !!changes.__act.newValue;
            renderRunState(!!changes.__act.newValue);
        }
        if (changes.__ab) $("autobook").checked = !!changes.__ab.newValue;
        if (changes.__fq) $("frequencyValue").value = changes.__fq.newValue;
        if (changes.__fqType) {
            const ft = $("frequencyType"), val = changes.__fqType.newValue;
            for (const opt of ft.options) if (opt.value === val) { opt.selected = true; break; }
        }
        if (changes.__usr) $("currentUser").textContent = changes.__usr.newValue || "Not signed in";
        if (changes.__consularCities || changes.__consularSelectedCities || changes.__ofcCities || changes.__ofcSelectedCities) {
            loadCityLists();
        }
    });
});
