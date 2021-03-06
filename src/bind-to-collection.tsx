import * as React from "react";
import { database } from "./init";
import { isEqual, difference } from "lodash";

/// <reference path="../react.d.ts" />

const enum Status {
  Pending,
  LoadedFromLocalStorage,
  LoadedFromFirebase
}

interface IFirebaseQuery {
  endAt?: {
    value?: number | string | boolean;
    key?: string;
  };
  equalTo?: {
    value?: number | string | boolean;
    key?: string;
  };
  limitToFirst?: number;
  limitToLast?: number;
  orderByChild?: string;
  orderByKey?: boolean;
  orderByPriority?: boolean;
  orderByValue?: boolean;
  startAt?: {
    value?: number | string | boolean;
    key?: string;
  };
}

interface IState<T>{
  status: Status;
  data?: { [id: string]: T };
}

type InnerProps<T, P> = { data: { [id: string]: T }} & P;
type OuterProps<P> = {
  firebaseRef: string;
  firebaseQuery?: IFirebaseQuery;
  cacheLocally?: boolean;
  storage?: Storage;
  loader?: (props: P) => JSX.Element;
  debug?: boolean;
} & P;

interface Storage {
  getItem(key: string): string;
  setItem(key: string, value: string);
}

export function bindToCollection<T, P>(innerKlass: React.ComponentClass<InnerProps<T, P>>): React.ComponentClass<OuterProps<P>> {
  class BindToCollection extends React.Component<OuterProps<P>, IState<T>> {
    private static propKeys = ["debug", "firebaseRef", "cacheLocally", "firebaseQuery", "storage", "loader"];
    private unbind: () => void;

    constructor(props: OuterProps<P>) {
      super(props);

      this.reset(props, false);
    }

    public render(): JSX.Element {
      this.debug("Rendering");
      const innerProps = this.buildInnerProps(this.props);
      if (this.state.status === Status.Pending) {
        if (this.props.loader) {
          return this.props.loader(innerProps);
        }
        return null;
      }

      return React.createElement<InnerProps<T, P>>(innerKlass, innerProps);
    }

    public componentWillUnmount() {
      this.debug("Unmounting");
      if (this.unbind) {
        this.debug("Unbinding Firebase listener");
        this.unbind();
      }
    }

    public shouldComponentUpdate(nextProps: OuterProps<P>, nextState: IState<T>): boolean {
      // Yes if reference has changed
      if (nextProps.firebaseRef !== nextProps.firebaseRef) {
        this.debug("Updating since Firebase reference has changed");
        return true;
      }

      // Yes if query has changed
      if (!isEqual(this.props.firebaseQuery, nextProps.firebaseQuery)) {
        this.debug("Updating since Firebase query has changed");
        return true;
      }

      // Yes if finished loading
      if (this.state.status === Status.Pending && nextState.status !== Status.Pending) {
        this.debug("Updating since status has changed");
        return true;
      }

      // Yes if user-supplier props have changed
      if (!isEqual(this.buildOtherProps(this.props), this.buildOtherProps(nextProps))) {
        this.debug("Updating since user-supplied props have changed");
        return true;
      }

      // Otherwise do deep comparison of data
      if (!isEqual(this.state.data, nextState.data)) {
        this.debug("Updating since data has changed");
        return true;
      }

      return false;
    }

    public componentWillReceiveProps(nextProps: OuterProps<P>) {
      // reset if reference or query change
      if (this.props.firebaseRef !== nextProps.firebaseRef || !isEqual(this.props.firebaseQuery, nextProps.firebaseQuery)) {
        this.debug("Reseting since Firebase reference or query have changed");
        this.reset(nextProps, true);
      }
    }

    private reset(props: OuterProps<P>, useSetState?: boolean) {
      const state: IState<T> = { status: Status.Pending };


      if (props.cacheLocally) {
        this.debug("Checking storage for cached data");
        const localStorageData = checkStorage<{ [id: string]: T }>(props.firebaseRef, props.firebaseQuery, props.storage);
        if (localStorageData) {
          this.debug("Cache hit");
          state.data = localStorageData;
          state.status = Status.LoadedFromLocalStorage;
        }
      }

      if (this.unbind) {
        this.debug("Unbinding deprecated Firebase listener");
        this.unbind();
        this.unbind = undefined;
      }

      const callback = this.updateData.bind(this);

      let reference: firebase.database.Query = database().ref(props.firebaseRef);
      if (props.firebaseQuery) {
        reference = applyQuery(reference, props.firebaseQuery);
      }
      this.debug("Registering Firebase listener");
      reference.on("value", callback);

      this.unbind = () => {
        reference.off("value", callback);
      };

      if (useSetState) {
        this.setState(state);
      } else {
        this.state = state;
      }
    }

    private buildOtherProps(outerProps: OuterProps<P>): P {
      const otherProps = {} as P;

      for (const id of difference(Object.keys(outerProps), BindToCollection.propKeys)) {
        otherProps[id] = outerProps[id];
      }

      return otherProps;
    }

    private buildInnerProps(outerProps: OuterProps<P>): InnerProps<T, P> {
      const innerProps = this.buildOtherProps(outerProps) as InnerProps<T, P> ;
      innerProps.data = this.state.data;

      return innerProps;
    }

    private updateData(snapshot: firebase.database.DataSnapshot) {
      let val = snapshot.val() as { [id: string]: T };

      if (!val || Object.keys(val).length === 0) {
        val = {};
      }

      this.setState({ data: val, status: Status.LoadedFromFirebase });

      if (this.props.cacheLocally) {
        saveToStorage<{ [id: string]: T }>(this.props.firebaseRef, this.props.firebaseQuery, val, this.props.storage);
      }
    }

    private debug(message: string) {
      if (this.props.debug) {
        console.log(`bindToCollection[${this.props.firebaseRef}]: ${message}`);
      }
    }
  };

  return BindToCollection;
}

function localStorageKey(firebaseRef: string, query: IFirebaseQuery): string {
  return `firebase-cache-collection:${firebaseRef}:${(query && JSON.stringify(query)) || "all"}`;
}

function saveToStorage<T>(firebaseRef: string, query: IFirebaseQuery, data: T, storageObject?: Storage) {
  const storage = storageObject || window.localStorage;

  try {
    storage.setItem(localStorageKey(firebaseRef, query), JSON.stringify(data));
  } catch (err) {
    console.error(err.message);
  }
}

function checkStorage<T>(firebaseRef: string, query: IFirebaseQuery, storageObject?: Storage): T {
  const storage = storageObject || window.localStorage;
  const item = storage.getItem(localStorageKey(firebaseRef, query));

  if (item) {
    return JSON.parse(item);
  }
}

function applyQuery(ref: firebase.database.Query, query: IFirebaseQuery): firebase.database.Query {
  if (query.startAt !== undefined) {
    ref = ref.startAt(query.startAt.value, query.startAt.key);
  }

  if (query.equalTo !== undefined) {
    ref = ref.equalTo(query.equalTo.value, query.equalTo.key);
  }

  if (query.endAt !== undefined) {
    ref = ref.endAt(query.endAt.value, query.endAt.key);
  }

  if (query.orderByValue) {
    ref = ref.orderByValue();
  }

  if (query.orderByPriority) {
    ref = ref.orderByPriority();
  }

  if (query.orderByKey) {
    ref = ref.orderByKey();
  }

  if (query.orderByChild !== undefined) {
    ref = ref.orderByChild(query.orderByChild);
  }

  if (query.limitToLast !== undefined) {
    ref = ref.limitToLast(query.limitToLast);
  }

  if (query.limitToFirst !== undefined) {
    ref = ref.limitToFirst(query.limitToFirst);
  }

  return ref;
}
