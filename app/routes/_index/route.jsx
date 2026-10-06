import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden="true" />

      <main className={styles.hero}>
        <p className={styles.brand}>Follow Artist</p>
        <h1 className={styles.heading}>
          Stay close to the artists your customers love
        </h1>
        <p className={styles.text}>
          Let shoppers follow their favourite artists and get notified the moment
          a new product goes live.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label} htmlFor="shop">
              Shop domain
            </label>
            <div className={styles.ctaRow}>
              <input
                id="shop"
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="off"
                required
              />
              <button className={styles.button} type="submit">
                Open app
              </button>
            </div>
            <span className={styles.hint}>
              Use your myshopify.com domain to install or open the app
            </span>
          </Form>
        )}
      </main>

      <section className={styles.steps} aria-label="How it works">
        <div className={styles.step}>
          <span className={styles.stepIndex}>01</span>
          <h2 className={styles.stepTitle}>Follow</h2>
          <p className={styles.stepText}>
            Customers follow artists from artist pages in one tap.
          </p>
        </div>
        <div className={styles.step}>
          <span className={styles.stepIndex}>02</span>
          <h2 className={styles.stepTitle}>Publish</h2>
          <p className={styles.stepText}>
            When an artist releases new work, followers are ready to see it.
          </p>
        </div>
        <div className={styles.step}>
          <span className={styles.stepIndex}>03</span>
          <h2 className={styles.stepTitle}>Notify</h2>
          <p className={styles.stepText}>
            In-store notifications keep collectors in the loop instantly.
          </p>
        </div>
      </section>
    </div>
  );
}
