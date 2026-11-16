// Compact element builders for Tier 0 fixtures (the shapes `observeTab` produces).
export const text = (ref, name, extra = {}) => ({ ref, role: "textbox", name, value: "", required: true, ...extra });
export const area = (ref, name, extra = {}) => ({ ref, role: "textarea", name, value: "", required: true, ...extra });
export const pick = (ref, name, options, extra = {}) => ({ ref, role: "select", name, value: "", options, required: true, ...extra });
export const combo = (ref, name, extra = {}) => ({ ref, role: "combobox", name, value: "", popup: true, required: true, ...extra });
export const box = (ref, name, extra = {}) => ({ ref, role: "checkbox", name, checked: false, required: true, ...extra });
export const file = (ref, name, extra = {}) => ({ ref, role: "file", name, value: "", required: true, ...extra });
export const button = (ref, name, extra = {}) => ({ ref, role: "button", name, ...extra });
/** A pick-one question made of buttons (Ashby pills): `options` share one group. */
export const pills = (prefix, group, options, extra = {}) => options.map((name, i) => ({ ref: `${prefix}${i}`, role: "button", name, group, pressed: false, required: true, ...extra }));
/** A radio group. */
export const radios = (prefix, group, options, extra = {}) => options.map((name, i) => ({ ref: `${prefix}${i}`, role: "radio", name, group, checked: false, required: true, ...extra }));

/** The core contact block every fixture shares: the profile answers all four without asking. */
export const contact = () => [text("fn", "Full name"), text("em", "Email"), text("ph", "Phone", { input_type: "tel" })];
