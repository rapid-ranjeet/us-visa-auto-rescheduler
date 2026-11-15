let isLoginSubmitted = !1,
    isAutomationActive = !1,
    isOnboardingInProgress = !1,
    securityQuestionsHandled = !1;
const __SCRAMBLE_KEY = "scramble_29k_1z";

// Prefix used to identify newly-scrambled values vs old plaintext storage
const __SCRAMBLE_PREFIX = "__nx__";

function scramble(e) {
    if (!e || !__SCRAMBLE_KEY) return e;
    try {
        let r = '';
        for (let i = 0; i < e.length; i++)
            r += String.fromCharCode(e.charCodeAt(i) ^ __SCRAMBLE_KEY.charCodeAt(i % __SCRAMBLE_KEY.length));
        return __SCRAMBLE_PREFIX + btoa(r);
    } catch { return e; }
}

function unscramble(e) {
    if (!e || !__SCRAMBLE_KEY) return e;
    // Backward-compat: old plaintext values (passwords, security answers) have no prefix
    // → return them as-is. New values start with __SCRAMBLE_PREFIX and are XOR-decoded.
    if (!String(e).startsWith(__SCRAMBLE_PREFIX)) return e;
    try {
        let decoded = atob(e.slice(__SCRAMBLE_PREFIX.length));
        let r = '';
        for (let i = 0; i < decoded.length; i++)
            r += String.fromCharCode(decoded.charCodeAt(i) ^ __SCRAMBLE_KEY.charCodeAt(i % __SCRAMBLE_KEY.length));
        return r;
    } catch { return e; }
}
// Backend removed: generateSignature was only used for vendor API auth.

// ======== IMAGE HELPER ========
function nativeClick(id) {
    let e = document.getElementById(id);
    if (e) {
        e.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: !0,
            cancelable: !0,
            view: window
        }));
        e.dispatchEvent(new MouseEvent("mouseup", {
            bubbles: !0,
            cancelable: !0,
            view: window
        }));
        e.dispatchEvent(new MouseEvent("click", {
            bubbles: !0,
            cancelable: !0,
            view: window
        }));
    }
}

// ======== MAIN AUTOMATION ========
async function checkStatusActivate() {
    try {
        let {
            fp_act: e
        } = await chrome.storage.local.get(["fp_act"]);
        (isAutomationActive = e || !1) && runOnboardingSequence()
    } catch (t) {
        console.warn("Error checking initial activation status:", t)
    }
}
async function enableAutomationFeatures() {
    let u = await chrome.storage.local.get("fp_usr").then(e => e.fp_usr);
    // Backend removed: no server-side ban check.

    await new Promise(e => setTimeout(e, 2e3));
    if (document.getElementById("signInName") && document.getElementById("password")) setTimeout(fillForm, 1e3);
    let kbq = Array.from(document.querySelectorAll('[id^="kbq"][aria-label]'));
    let kba = Array.from(document.querySelectorAll('input[id^="kba"][id$="_response"]'));
    if (kbq.length >= 2 || kba.length >= 2) setTimeout(fillSecurityQuestions, 1e3);
    if (document.getElementById("terms-conditions-confirmation")) setTimeout(setPolicy, 1e3);
    isAutomationActive = !0;
}

function disableAutomationFeatures() {
    isAutomationActive = !1
}

async function runOnboardingSequence() {
    try {
        // Never show modals on Cloudflare challenge or waiting room pages
        const _cfTitle = (document.title || '').trim();
        if (_cfTitle === 'Just a moment...' || _cfTitle === 'Waiting Room powered by Cloudflare') {
            isOnboardingInProgress = false;
            console.log('[FalconPath content] Skipping onboarding — Cloudflare challenge page');
            return;
        }

        isOnboardingInProgress = !0;

        // Check if onboarding is needed
        let {
            fp_uc: uc
        } = await chrome.storage.local.get(["fp_uc"]);
        if (uc !== true) {
            if (typeof Swal === "undefined") {
                console.warn("Swal library not available for onboarding");
                isOnboardingInProgress = !1;
                return;
            }
            await Swal.fire({
                title: "Instructions",
                html: "<p>Please add the following information to start the search: <br> 1. Your email address <br> 2. Your password <br> 3. Your security questions and answers</p>",
                icon: "warning",
                confirmButtonText: "Start",
                allowEscapeKey: !1,
                allowEnterKey: !1,
                allowOutsideClick: !1
            });
            await chrome.storage.local.set({
                fp_uc: !0
            });
            await new Promise(e => setTimeout(e, 1000));
        }

        let t = await chrome.storage.local.get("fp_usr").then(e => e.fp_usr);
        let o = await chrome.storage.local.get("fp_pw").then(e => e.fp_pw ? unscramble(e.fp_pw) : null);
        let i = await chrome.storage.local.get("fp_sq").then(e => e.fp_sq);

        if (uc === true && t && o && i) {
            isOnboardingInProgress = !1;
            enableAutomationFeatures();
            return;
        }

        if (!t) {
            t = await Swal.fire({
                title: "",
                html: "Please enter your credentials to start the search",
                input: "text",
                inputLabel: "Your email or username",
                inputPlaceholder: "Enter your email or username",
                customClass: {
                    input: "fp-square-input"
                },
                allowEscapeKey: !1,
                allowEnterKey: !1,
                allowOutsideClick: !1,
                confirmButtonText: "Next",
                inputValidator: value => {
                    let v = (value || "").trim().toLowerCase();
                    if (!v) return "Email or username is required";
                    let isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !v.includes("..") && !v.includes("/") && !v.includes("\\");
                    let isUsername = /^[a-z0-9._-]{3,50}$/.test(v);
                    return isEmail || isUsername ? void 0 : "Enter a valid email or username";
                }
            }).then(e => {
                let v = (e.value || "").trim().toLowerCase();
                chrome.storage.local.set({
                    fp_usr: v
                });
                return v;
            });
        }

        if (!o) {
            o = await Swal.fire({
                title: "",
                html: "Please provide the password to login to your appointment.",
                input: "password",
                inputLabel: "Your password",
                inputPlaceholder: "Enter your password",
                customClass: {
                    input: "fp-square-input"
                },
                allowEscapeKey: !1,
                allowEnterKey: !1,
                allowOutsideClick: !1,
                confirmButtonText: "Submit"
            }).then(e => {
                chrome.storage.local.set({
                    fp_pw: scramble(e.value)
                });
                return e.value;
            });
        }

        if (!i) {
            i = await Swal.fire({
                title: "Security Questions",
                html: `
              <style>
                .fp-square-input {
                    border-radius: 4px !important;
                    font-family: inherit !important;
                }
                .question-answer-container { margin-bottom: 1em; text-align: left; }
                .question-select { 
                    width: 100%; 
                    margin-bottom: .5em; 
                    height: 44px;
                    padding: 0 12px; 
                    border: 1px solid #555; 
                    border-radius: 4px; 
                    box-sizing: border-box; 
                    font-family: inherit; 
                    background: transparent;
                    color: inherit;
                    font-size: 14px;
                }
                .answer-input { 
                    width: 100%; 
                    height: 44px;
                    padding: 0 12px; 
                    border: 1px solid #555; 
                    border-radius: 4px; 
                    box-sizing: border-box; 
                    font-family: inherit;
                    background: transparent;
                    color: inherit;
                    font-size: 14px;
                }
              </style>
              <p style="margin-bottom: 1em;">Please select 3 security questions and provide their answers.</p>
              <div class="input-table">
                <!-- Question 1 -->
                <div class="question-answer-grid-container" style="display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; gap: 0.25em 1em; margin-bottom: 1em;">
                    <label style="grid-column: 1; text-align: left;">Security Question 1:</label><label style="grid-column: 2; text-align: left;">Answer 1:</label>
                    <select id="question1" class="question-select" style="grid-column: 1;">
                        <option value="">Select Question 1</option>
                        <option value="spouse">Where did you meet your spouse?</option>
                        <option value="street">What is the name of the road/street you grew up on?</option>
                        <option value="mother">What is your mother's maiden name?</option>
                        <option value="car">What was your first car?</option>
                        <option value="job">In what city or town was your first job?</option>
                        <option value="foodLeast">What is your least favorite food?</option>
                        <option value="foodFav">What is your favorite food?</option>
                        <option value="school">What high school did you attend?</option>
                        <option value="pet">What was the name of your first/current/favorite pet?</option>
                        <option value="hero">Who was your childhood hero?</option>
                        <option value="company">What was the first company that you worked for?</option>
                        <option value="born">What is the name of the town/city where you were born?</option>
                        <option value="college">What is the name of a college you applied to but didnt attend?</option>
                        <option value="sibling">What is your sibling's middle name?</option>
                    </select>
                    <input type="text" id="answer1" placeholder="Answer 1" class="answer-input" style="grid-column: 2;">
                </div>
                <!-- Question 2 -->
                <div class="question-answer-grid-container" style="display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; gap: 0.25em 1em; margin-bottom: 1em;">
                    <label style="grid-column: 1; text-align: left;">Security Question 2:</label><label style="grid-column: 2; text-align: left;">Answer 2:</label>
                    <select id="question2" class="question-select" style="grid-column: 1;">
                        <option value="">Select Question 2</option>
                        <option value="spouse">Where did you meet your spouse?</option>
                        <option value="street">What is the name of the road/street you grew up on?</option>
                        <option value="mother">What is your mother's maiden name?</option>
                        <option value="car">What was your first car?</option>
                        <option value="job">In what city or town was your first job?</option>
                        <option value="foodLeast">What is your least favorite food?</option>
                        <option value="foodFav">What is your favorite food?</option>
                        <option value="school">What high school did you attend?</option>
                        <option value="pet">What was the name of your first/current/favorite pet?</option>
                        <option value="hero">Who was your childhood hero?</option>
                        <option value="company">What was the first company that you worked for?</option>
                        <option value="born">What is the name of the town/city where you were born?</option>
                        <option value="college">What is the name of a college you applied to but didnt attend?</option>
                        <option value="sibling">What is your sibling's middle name?</option>
                    </select>
                    <input type="text" id="answer2" placeholder="Answer 2" class="answer-input" style="grid-column: 2;">
                </div>
                <!-- Question 3 -->
                <div class="question-answer-grid-container" style="display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; gap: 0.25em 1em; margin-bottom: 1em;">
                    <label style="grid-column: 1; text-align: left;">Security Question 3:</label><label style="grid-column: 2; text-align: left;">Answer 3:</label>
                    <select id="question3" class="question-select" style="grid-column: 1;">
                        <option value="">Select Question 3</option>
                        <option value="spouse">Where did you meet your spouse?</option>
                        <option value="street">What is the name of the road/street you grew up on?</option>
                        <option value="mother">What is your mother's maiden name?</option>
                        <option value="car">What was your first car?</option>
                        <option value="job">In what city or town was your first job?</option>
                        <option value="foodLeast">What is your least favorite food?</option>
                        <option value="foodFav">What is your favorite food?</option>
                        <option value="school">What high school did you attend?</option>
                        <option value="pet">What was the name of your first/current/favorite pet?</option>
                        <option value="hero">Who was your childhood hero?</option>
                        <option value="company">What was the first company that you worked for?</option>
                        <option value="born">What is the name of the town/city where you were born?</option>
                        <option value="college">What is the name of a college you applied to but didnt attend?</option>
                        <option value="sibling">What is your sibling's middle name?</option>
                    </select>
                    <input type="text" id="answer3" placeholder="Answer 3" class="answer-input" style="grid-column: 2;">
                </div>
              </div>
            `,
                allowEscapeKey: !1,
                allowEnterKey: !1,
                allowOutsideClick: !1,
                confirmButtonText: "Submit",
                focusConfirm: !1,
                preConfirm() {
                    let s1 = document.getElementById("question1");
                    let q1 = s1.options[s1.selectedIndex].text;
                    let a1 = document.getElementById("answer1").value.trim();
                    let s2 = document.getElementById("question2");
                    let q2 = s2.options[s2.selectedIndex].text;
                    let a2 = document.getElementById("answer2").value.trim();
                    let s3 = document.getElementById("question3");
                    let q3 = s3.options[s3.selectedIndex].text;
                    let a3 = document.getElementById("answer3").value.trim();
                    if (a1 && a2 && a3 && s1.value !== "" && s2.value !== "" && s3.value !== "") {
                        return [{
                            question: q1,
                            answer: scramble(a1)
                        }, {
                            question: q2,
                            answer: scramble(a2)
                        }, {
                            question: q3,
                            answer: scramble(a3)
                        }];
                    } else {
                        Swal.showValidationMessage("Please select a question and provide an answer for all three entries.");
                        return !1;
                    }
                }
            }).then(e => {
                if (e.isConfirmed && e.value) {
                    chrome.storage.local.set({
                        fp_sq: e.value
                    });
                    return e.value;
                }
                return null;
            });
        }

        isOnboardingInProgress = false;
        enableAutomationFeatures();
    } catch (err) {
        isOnboardingInProgress = !1
    }
}

async function fillSecurityQuestions() {
    securityQuestionsHandled = true;

    let savedQuestions = await chrome.storage.local.get("fp_sq").then(e => e.fp_sq);

    if (!savedQuestions || !Array.isArray(savedQuestions) || savedQuestions.length === 0) {
        console.warn("No saved security questions found in storage.");
        return;
    }

    const questionEls = Array.from(document.querySelectorAll('[id^="kbq"][aria-label]'));
    const answerEls = Array.from(document.querySelectorAll('input[id^="kba"][id$="_response"]'));

    if (!questionEls.length || !answerEls.length) {
        console.warn("Security question fields not found on page.");
        return;
    }

    const normalize = (str) =>
        String(str || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    let filledCount = 0;

    for (let i = 0; i < questionEls.length; i++) {
        const labelText = normalize(questionEls[i].getAttribute("aria-label"));
        const input = answerEls[i];
        if (!input) continue;

        let foundAnswer = "";

        for (let j = 0; j < savedQuestions.length; j++) {
            const savedQuestion = normalize(savedQuestions[j].question);
            const savedAnswer = unscramble(savedQuestions[j].answer);

            if (
                (savedQuestion.includes("spouse") && labelText.includes("spouse")) ||
                (savedQuestion.includes("street") && (labelText.includes("grew") || labelText.includes("road") || labelText.includes("street"))) ||
                (savedQuestion.includes("mother") && labelText.includes("mother")) ||
                (savedQuestion.includes("car") && labelText.includes("car")) ||
                (savedQuestion.includes("job") && (labelText.includes("job") || labelText.includes("city") || labelText.includes("town"))) ||
                (savedQuestion.includes("school") && labelText.includes("school")) ||
                (savedQuestion.includes("pet") && labelText.includes("pet")) ||
                (savedQuestion.includes("hero") && labelText.includes("hero")) ||
                (savedQuestion.includes("food") && labelText.includes("food")) ||
                (savedQuestion.includes("company") && labelText.includes("company")) ||
                (savedQuestion.includes("born") && labelText.includes("born")) ||
                (savedQuestion.includes("college") && labelText.includes("college")) ||
                (savedQuestion.includes("sibling") && labelText.includes("sibling"))
            ) {
                foundAnswer = savedAnswer;
                break;
            }
        }

        if (foundAnswer) {
            input.focus();
            input.value = foundAnswer;
            input.dispatchEvent(new Event("input", {
                bubbles: true
            }));
            input.dispatchEvent(new Event("change", {
                bubbles: true
            }));
            filledCount++;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log(`Filled ${filledCount} security answers.`);

    if (filledCount > 0) {
        await new Promise(r => setTimeout(r, 1200));
        nativeClick("continue");
    } else {
        console.warn("No matching security answers found.");
    }
}
// ======== LOGIN SUBMIT ========
async function fillForm() {
    let e = await chrome.storage.local.get("fp_usr").then(e => e.fp_usr);
    let t = await chrome.storage.local.get("fp_pw").then(e => e.fp_pw ? unscramble(e.fp_pw) : null);

    // Fill username & password
    setTimeout(() => {
        let o = document.getElementById("signInName"),
            i = document.getElementById("password");
        o && i && (o.value = e || "", i.value = t || "");
    }, 1e3);

    // Submit the sign-in form directly once the fields have been filled in above.
    if (e && t && !isLoginSubmitted) {
        isLoginSubmitted = !0;
        setTimeout(() => {
            if (!isAutomationActive || isOnboardingInProgress) return;
            nativeClick("continue");

            // If login failed (bad saved credentials, etc.) allow a retry
            // on the next page load instead of getting stuck forever.
            setTimeout(() => {
                const errBox = document.getElementById("claimVerificationServerError");
                if (errBox && "block" === errBox.style.display) {
                    isLoginSubmitted = !1;
                }
            }, 3e3);
        }, 2e3);
    }
}

async function setPolicy() {
    nativeClick("terms-conditions-confirmation"), nativeClick("submit-agreement")
}

// ======== BAN POPUP — FULL SCREEN BLOCKER ========
// Backend removed: function showBanPopup deleted.

// ======== STARTUP BAN CHECK ========
// Backend removed: async function checkBanStatus deleted.

chrome.runtime.onMessage.addListener((e, t, o) => ("activate" === e.action && ((isAutomationActive = e.status) ? runOnboardingSequence() : (isOnboardingInProgress = !1, disableAutomationFeatures())), !0)), checkStatusActivate();