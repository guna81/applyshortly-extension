// Reduced public control structure, with synthetic questions and no applicant data.
export const ashbyYesNo = (question = 'Have you used Python professionally?', required = true) => `
<div class="ashby-application-form-field-entry">
  <label class="ashby-application-form-question-title ${required ? '_required_fixture_91' : ''}">${question}</label>
  <div class="ashby-application-form-input-yesno">
    <button type="button" aria-pressed="false" data-option="yes">Yes</button>
    <button type="button" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" tabindex="-1" name="backing" style="display:none">
  </div>
</div>`;
export const ashbyProviders = `<fieldset class="ashby-application-form-input-checkbox-group">
  <label class="ashby-application-form-question-title _required_fixture_91">Which providers have you used?</label>
  <label><input type="checkbox" value="OpenAI">OpenAI</label>
  <label><input type="checkbox" value="Llama">Llama</label>
</fieldset>`;
export const ashbyConsent = `<fieldset class="ashby-application-form-input-checkbox-group">
  <label class="ashby-application-form-question-title _required_fixture_91"></label>
  <label><input type="checkbox" id="consent">I agree to recruitment communications</label>
</fieldset>`;
export const ashbyReceipt = `<div role="status" class="ashby-application-form-success-container" data-highlight="positive">
  <h2>Success</h2><p>Thank you for your interest in joining our team!</p>
</div>`;
