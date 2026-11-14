import { Link } from "react-router-dom";

export default function PrivacyPage() {
  return (
    <main className="wrap" style={{ maxWidth: 720 }}>
      <h1>Privacy</h1>
      <p className="sub">Lena Dena Ledger is a small personal app for keeping track of money between friends.</p>
      <section className="panel">
        <h2>What's stored</h2>
        <ul>
          <li>Your username, and a hashed password if you sign up with one.</li>
          <li>If you sign in with Google: an ID from Google that links it to your account. Your name and email from Google are only used to suggest a username and are not stored.</li>
          <li>The ledger entries and word list you create.</li>
        </ul>
        <h2>What's sent elsewhere</h2>
        <ul>
          <li>When you use voice entry, the recording and the sentence are sent to Groq to be turned into text and entries. Recordings aren't kept by this app.</li>
          <li>Nothing is sold or shared with advertisers.</li>
        </ul>
        <h2>Deleting your data</h2>
        <p>Ask the person who runs this app to delete your account and everything in it. You can download your entries as a CSV at any time.</p>
      </section>
      <p><Link to="/login">Back to the app</Link></p>
    </main>
  );
}
