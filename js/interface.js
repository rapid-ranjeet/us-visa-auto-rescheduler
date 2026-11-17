document.addEventListener("DOMContentLoaded", async () => {
    const $ = (id) => document.getElementById(id);

    $("fpVersion").textContent = "v" + chrome.runtime.getManifest().version;

    /* ── Location lists ────────────────────────────────────────── */
    function renderCityList(containerId, allCities, selected) {
        const container = $(containerId);
        if (!container) return;
        allCities = allCities || {};
        selected = Array.isArray(selected) ? selected : [];
        const ids = Object.keys(allCities);
        if (!ids.length) {
            container.innerHTML = `<div class="city-empty">Open the matching scheduling page once to load locations.</div>`;
            return;
        }
        container.innerHTML = "";
        ids.sort((a, b) => allCities[a].localeCompare(allCities[b])).forEach(id => {
            const row = document.createElement("label");
            row.className = "city-item";
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
        const s = await chrome.storage.local.get(["fp_ofcSelectedCities", "fp_consularSelectedCities"]);
        const ofc = (s.fp_ofcSelectedCities || []).length;
        const con = (s.fp_consularSelectedCities || []).length;
        const parts = [];
        if (ofc) parts.push(ofc + " OFC");
        if (con) parts.push(con + " Consular");
        $("fpLocationsSummary").textContent = parts.length ? parts.join(" · ") : "NONE SELECTED";
    }

    async function loadCityLists() {
        const s = await chrome.storage.local.get(["fp_consularCities", "fp_consularSelectedCities", "fp_ofcCities", "fp_ofcSelectedCities"]);
        renderCityList("fpOfcCityList", s.fp_ofcCities, s.fp_ofcSelectedCities);
        renderCityList("fpConsularCityList", s.fp_consularCities, s.fp_consularSelectedCities);
        await updateLocationsSummary();
    }

    await loadCityLists();

    $("fpConsularCityList").addEventListener("change", async e => {
        if (e.target?.matches('input[type="checkbox"]')) {
            await toggleCitySelection("fp_consularSelectedCities", e.target.dataset.cityId, e.target.checked);
            await updateLocationsSummary();
        }
    });
    $("fpOfcCityList").addEventListener("change", async e => {
        if (e.target?.matches('input[type="checkbox"]')) {
            await toggleCitySelection("fp_ofcSelectedCities", e.target.dataset.cityId, e.target.checked);
            await updateLocationsSummary();
        }
    });

    /* ── Collapsible location groups ───────────────────────────── */
    document.querySelectorAll(".loc-head").forEach(head => {
        const flip = () => {
            const group = head.closest(".loc-group");
            const open = group.classList.toggle("open");
            head.setAttribute("aria-expanded", open ? "true" : "false");
        };
        head.addEventListener("click", flip);
        head.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
        });
    });
    document.querySelectorAll(".loc-group").forEach(g => g.classList.add("open"));

    /* ── Hero status + power button ────────────────────────────── */
    function renderRunState(active) {
        const hero = $("fpHeroStatus");
        hero.classList.toggle("active", !!active);
        $("fpHeroText").textContent = active ? "Scanning" : "Idle";
        document.body.classList.toggle("fp-running", !!active);
        $("fpPowerLabel").textContent = active ? "Stop scanning" : "Start scanning";
    }

    /* ── Date-range hint ───────────────────────────────────────── */
    function renderDatesHint() {
        const s = $("fpStart").value, e = $("fpEnd").value;
        const el = $("fpDatesHint");
        if (!s || !e) {
            el.textContent = "Set both dates to begin";
            el.classList.remove("ok");
        } else {
            const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000) + 1);
            el.textContent = `${days}d window · ${s} → ${e}`;
            el.classList.add("ok");
        }
    }

    /* ── Initial load ──────────────────────────────────────────── */
    const s0 = await chrome.storage.local.get();
    $("fpCurrentUser").textContent = (s0.fp_usr || "Not signed in");
    $("fpEnable").checked = !!s0.fp_act;
    $("fpAutobook").checked = !!s0.fp_ab;
    $("fpWake").checked = !!s0.fp_wake;
    $("fpStart").value = s0.fp_st || new Date().toISOString().split("T")[0];
    $("fpEnd").value = s0.fp_en || "";
    $("fpFrequencyValue").value = s0.fp_fq || 30;
    const fqType = s0.fp_fqType || "seconds";
    for (const opt of $("fpFrequencyType").options) {
        if (opt.value === fqType) { opt.selected = true; break; }
    }
    renderRunState(!!s0.fp_act);
    renderDatesHint();

    /* ── Wire controls ─────────────────────────────────────────── */
    $("fpEnable").addEventListener("change", async function () {
        chrome.storage.local.set({ fp_act: this.checked });
        chrome.runtime.sendMessage({ action: "activate", status: this.checked });
        renderRunState(this.checked);
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "activate" }).catch(() => { });
    });

    $("fpAutobook").addEventListener("change", async function () {
        chrome.storage.local.set({ fp_ab: this.checked });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "autobook" }).catch(() => { });
    });

    $("fpStart").addEventListener("change", async function () {
        chrome.storage.local.set({ fp_st: this.value || new Date().toISOString().split("T")[0] });
        renderDatesHint();
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "from" }).catch(() => { });
    });

    $("fpEnd").addEventListener("change", async function () {
        const { fp_ad: ad } = await chrome.storage.local.get("fp_ad");
        if (this.value) { if (ad && new Date(ad) <= new Date(this.value)) this.value = ad; }
        else this.value = ad || "";
        chrome.storage.local.set({ fp_en: this.value || "" });
        renderDatesHint();
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "until" }).catch(() => { });
    });

    $("fpFrequencyValue").addEventListener("change", async function () {
        let v = parseInt(this.value) || 30;
        if (v < 1) { v = 1; this.value = 1; }
        if (v > 3600) { v = 3600; this.value = 3600; }
        chrome.storage.local.set({ fp_fq: v });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequency" }).catch(() => { });
    });

    $("fpFrequencyType").addEventListener("change", async function () {
        chrome.storage.local.set({ fp_fqType: this.value });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "notificate", value: "frequencyType" }).catch(() => { });
    });

    $("fpWake").addEventListener("change", async function () {
        chrome.storage.local.set({ fp_wake: this.checked });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.sendMessage(tab.id, { action: "wake", value: this.checked });
    });

    $("fpReset").addEventListener("click", (e) => {
        e.preventDefault();
        chrome.storage.local.clear(() => {
            chrome.storage.sync.clear(() => {
                chrome.storage.local.set({ fp_act: true }, () => {
                    $("fpEnable").checked = true;
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
        if (changes.fp_st) { $("fpStart").value = changes.fp_st.newValue || new Date().toISOString().split("T")[0]; renderDatesHint(); }
        if (changes.fp_en) {
            chrome.storage.local.get("fp_ad").then(({ fp_ad: ad }) => {
                let v = changes.fp_en.newValue;
                if (v) { if (ad && new Date(ad) <= new Date(v)) v = ad; } else v = ad || "";
                $("fpEnd").value = v;
                renderDatesHint();
            });
        }
        if (changes.fp_act) {
            $("fpEnable").checked = !!changes.fp_act.newValue;
            renderRunState(!!changes.fp_act.newValue);
        }
        if (changes.fp_ab) $("fpAutobook").checked = !!changes.fp_ab.newValue;
        if (changes.fp_fq) $("fpFrequencyValue").value = changes.fp_fq.newValue;
        if (changes.fp_fqType) {
            const ft = $("fpFrequencyType"), val = changes.fp_fqType.newValue;
            for (const opt of ft.options) if (opt.value === val) { opt.selected = true; break; }
        }
        if (changes.fp_usr) $("fpCurrentUser").textContent = changes.fp_usr.newValue || "Not signed in";
        if (changes.fp_consularCities || changes.fp_consularSelectedCities || changes.fp_ofcCities || changes.fp_ofcSelectedCities) {
            loadCityLists();
        }
    });
});
